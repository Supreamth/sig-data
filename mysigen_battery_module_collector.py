#!/usr/bin/env python3
"""MySigen per-battery module collector.

Discovers battery nodes from the MySigen topology API, fetches pack details for
those battery serial numbers, and writes honest per-module fields to InfluxDB.
It does not split aggregate battery SOC/power into fake per-module values.
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from typing import Any

import requests
from dotenv import load_dotenv
from logger import get_logger
from auth_handler import get_active_sigen_access_token

try:
    from influxdb_client import InfluxDBClient, Point, WritePrecision
    from influxdb_client.client.write_api import SYNCHRONOUS
    INFLUX_CLIENT_AVAILABLE = True
except ImportError:
    INFLUX_CLIENT_AVAILABLE = False
    InfluxDBClient = None  # type: ignore
    Point = None  # type: ignore
    WritePrecision = None  # type: ignore
    SYNCHRONOUS = None  # type: ignore

load_dotenv()
logger = get_logger(__name__)

SIGEN_BASE_URL = os.getenv("SIGEN_BASE_URL", "https://api-eu.sigencloud.com").rstrip("/")
SIGEN_STATION_ID = os.getenv("SIGEN_STATION_ID", "")
INTERVAL = int(os.getenv("MYSIGEN_BATTERY_MODULE_INTERVAL", "300"))
INFLUX_URL = os.getenv("INFLUXDB_URL", "http://localhost:8086")
INFLUX_TOKEN = os.getenv("INFLUXDB_TOKEN")
INFLUX_ORG = os.getenv("INFLUXDB_ORG")
INFLUX_BUCKET = os.getenv("INFLUXDB_BUCKET")
USER_AGENT = "MySigenBatteryModuleCollector/1.0"


def parse_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r"[-+]?[0-9]*\.?[0-9]+", str(value))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": USER_AGENT,
    }


def find_batteries(node: Any, out: list[dict[str, Any]]) -> None:
    if isinstance(node, dict):
        desc = str(node.get("deviceTypeDesc", "")).lower()
        if desc == "battery" or node.get("deviceType") == 4:
            sn = node.get("snCode") or node.get("showSnCode")
            if sn:
                out.append({
                    "device_sn": str(sn),
                    "safe_guard_score": parse_number(node.get("safeGuardScore")),
                    "device_status": parse_number(node.get("deviceStatus")),
                    "communicate_status": parse_number(node.get("communicateStatus")),
                })
        for value in node.values():
            find_batteries(value, out)
    elif isinstance(node, list):
        for item in node:
            find_batteries(item, out)


def discover_batteries(token: str) -> list[dict[str, Any]]:
    configured = [s.strip() for s in os.getenv("MYSIGEN_BATTERY_SNS", "").split(",") if s.strip()]
    if configured:
        return [{"device_sn": sn} for sn in configured]

    url = f"{SIGEN_BASE_URL}/device/devicetreepanel/topology"
    response = requests.get(url, headers=headers(token), params={"stationId": SIGEN_STATION_ID}, timeout=20)
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") not in (0, "0", None):
        raise RuntimeError(f"topology error code={payload.get('code')} msg={payload.get('msg')}")
    batteries: list[dict[str, Any]] = []
    find_batteries(payload.get("data"), batteries)
    # De-duplicate while preserving topology order.
    seen = set()
    unique = []
    for b in batteries:
        sn = b.get("device_sn")
        if sn and sn not in seen:
            seen.add(sn)
            unique.append(b)
    logger.info("Discovered %d battery module(s): %s", len(unique), [b.get("device_sn") for b in unique])
    return unique


def fetch_pack_info(token: str, device_sn: str) -> dict[str, float]:
    url = f"{SIGEN_BASE_URL}/device/device/pack/queryPackMergeInfo"
    response = requests.get(url, headers=headers(token), params={"stationId": SIGEN_STATION_ID, "snCode": device_sn}, timeout=20)
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") not in (0, "0", None):
        raise RuntimeError(f"pack info error sn={device_sn} code={payload.get('code')} msg={payload.get('msg')}")

    fields: dict[str, float] = {}
    for item in ((payload.get("data") or {}).get("paramInfoVOList") or []):
        key = str(item.get("paramKey", "")).lower()
        value = parse_number(item.get("paramValueText") or item.get("paramValue"))
        if value is None:
            continue
        if "total" in key and "discharge" in key:
            fields["total_discharge_kwh"] = value
        elif "average" in key and "cell" in key and "voltage" in key:
            fields["average_cell_voltage"] = value
        elif "average" in key and "cell" in key and "temperature" in key:
            fields["average_cell_temperature"] = value
    return fields


def write_battery_module(fields: dict[str, float], battery: dict[str, Any], battery_index: int) -> bool:
    if not fields:
        logger.info("No numeric pack fields for battery_index=%s sn=%s", battery_index, battery.get("device_sn"))
        return False
    if not INFLUX_CLIENT_AVAILABLE or not all([INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET]):
        logger.error("InfluxDB client/env unavailable; cannot write battery_module_metrics")
        return False

    point = (
        Point("battery_module_metrics")
        .tag("station_id", SIGEN_STATION_ID)
        .tag("device_sn", str(battery.get("device_sn")))
        .tag("battery_index", str(battery_index))
        .tag("source", "mysigen_pack_info")
        .time(datetime.now(timezone.utc), WritePrecision.NS)
    )
    merged = dict(fields)
    for key in ("safe_guard_score", "device_status", "communicate_status"):
        value = battery.get(key)
        if value is not None:
            merged[key] = float(value)
    for key, value in merged.items():
        point = point.field(key, float(value))

    with InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG) as client:
        client.write_api(write_options=SYNCHRONOUS).write(bucket=INFLUX_BUCKET, record=point)
    logger.info("Wrote battery_module_metrics index=%s sn=%s fields=%s", battery_index, battery.get("device_sn"), sorted(merged))
    return True


def run() -> None:
    if not SIGEN_STATION_ID:
        raise SystemExit("SIGEN_STATION_ID is required")
    batteries_cache: list[dict[str, Any]] = []
    logger.info("Starting MySigen battery module collector station_id=%s interval=%ss", SIGEN_STATION_ID, INTERVAL)
    while True:
        start = time.time()
        try:
            token = get_active_sigen_access_token()
            if not token:
                logger.warning("No active Sigen token; skipping battery module cycle")
            else:
                if not batteries_cache:
                    batteries_cache = discover_batteries(token)
                if not batteries_cache:
                    logger.warning("No battery modules discovered")
                for idx, battery in enumerate(batteries_cache, start=1):
                    sn = str(battery.get("device_sn"))
                    fields = fetch_pack_info(token, sn)
                    write_battery_module(fields, battery, idx)
        except Exception as exc:
            logger.exception("Battery module collection cycle failed: %s", exc)
        time.sleep(max(0.0, INTERVAL - (time.time() - start)))


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        logger.info("Battery module collector stopped")
