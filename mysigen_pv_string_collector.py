#!/usr/bin/env python3
"""MySigen PV string-level collector using MySigen app credentials.

Polls /device/pvPanel/realTimeInfo for PV1-PV4 string metrics and writes
normalized data into the existing InfluxDB pv_string_metrics measurement.

Required env:
  SIGEN_BASE_URL                  API base URL (default: https://api-eu.sigencloud.com)
  SIGEN_STATION_ID                Station ID
  SIGEN_TOKEN_FILE                Token file path (default: sigen_token.json)
  INFLUXDB_URL / _TOKEN / _ORG / _BUCKET
  MYSIGEN_PV_AIO_SN               AIO snCode override (auto-discovered when absent)
  SIGEN_PV_AIO_SN                 Alias for MYSIGEN_PV_AIO_SN
  MYSIGEN_PV_STRING_INTERVAL      Poll interval seconds (default: 60)
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from logger import get_logger

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

from auth_handler import get_active_sigen_access_token

load_dotenv()
logger = get_logger(__name__)

SIGEN_BASE_URL = os.getenv("SIGEN_BASE_URL", "https://api-eu.sigencloud.com").rstrip("/")
SIGEN_STATION_ID = os.getenv("SIGEN_STATION_ID", "")
MYSIGEN_PV_STRING_INTERVAL = int(os.getenv("MYSIGEN_PV_STRING_INTERVAL", "60"))
INFLUX_URL = os.getenv("INFLUXDB_URL", "http://localhost:8086")
INFLUX_TOKEN = os.getenv("INFLUXDB_TOKEN")
INFLUX_ORG = os.getenv("INFLUXDB_ORG")
INFLUX_BUCKET = os.getenv("INFLUXDB_BUCKET")

_USER_AGENT = "MySigenPvStringCollector/1.0"

# paramKey label keyword → field suffix, ordered so "today" wins before plain "power"
_PARAM_KEY_RULES: list[tuple[str, str]] = [
    ("voltage",   "voltage"),
    ("current",   "current"),
    ("today",     "today_kwh"),
    ("lifetime",  "lifetime_kwh"),
    ("power",     "power"),
]


def _parse_numeric(value) -> float | None:
    """Parse a value that may be a number, a numeric string, or a string with units."""
    if value is None or value == "" or str(value).strip() in ("--", "-", "N/A", "null"):
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    m = re.match(r"^[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?", s)
    if m:
        try:
            return float(m.group())
        except ValueError:
            pass
    return None


def _classify_param_key(param_key: str) -> str | None:
    """Map a paramKey label to a field suffix, or None if unrecognised."""
    k = param_key.lower()
    for keyword, suffix in _PARAM_KEY_RULES:
        if keyword in k:
            return suffix
    return None


def _infer_pv_index(item: dict, position: int) -> int:
    """Return 1-based PV string index from item metadata or array position."""
    for key in ("pvIndex", "pvNo", "stringIndex", "mpptIndex", "index", "no", "num"):
        val = item.get(key)
        if val is not None:
            try:
                idx = int(val)
                if 1 <= idx <= 16:
                    return idx
            except (ValueError, TypeError):
                pass
    for key in ("pvName", "name", "label", "title"):
        val = str(item.get(key, "")).lower()
        m = re.search(r"(\d+)", val)
        if m:
            idx = int(m.group(1))
            if 1 <= idx <= 16:
                return idx
    return position + 1


def _find_aio_sn_in_tree(node) -> str | None:
    """Recursively walk a topology tree node looking for an Aio device snCode."""
    if isinstance(node, dict):
        if "aio" in str(node.get("deviceTypeDesc", "")).lower():
            sn = node.get("snCode") or node.get("serialNumber") or node.get("sn")
            if sn:
                logger.info(
                    "Found AIO device snCode=%s (deviceTypeDesc=%s)",
                    sn, node.get("deviceTypeDesc"),
                )
                return str(sn)
        for value in node.values():
            result = _find_aio_sn_in_tree(value)
            if result:
                return result
    elif isinstance(node, list):
        for item in node:
            result = _find_aio_sn_in_tree(item)
            if result:
                return result
    return None


def discover_aio_sn(token: str, station_id: str) -> str | None:
    """Discover the AIO device snCode from the device topology endpoint."""
    url = f"{SIGEN_BASE_URL}/device/devicetreepanel/topology"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": _USER_AGENT,
    }
    logger.info("Discovering AIO snCode via topology for station_id=%s", station_id)
    try:
        resp = requests.get(url, headers=headers, params={"stationId": station_id}, timeout=20)
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("code") not in (0, "0", None):
            logger.error(
                "Topology API error code=%s msg=%s",
                payload.get("code"), payload.get("msg"),
            )
            return None
        sn = _find_aio_sn_in_tree(payload.get("data"))
        if not sn:
            logger.error(
                "No Aio node found in topology response. "
                "Set MYSIGEN_PV_AIO_SN or SIGEN_PV_AIO_SN explicitly."
            )
        return sn
    except requests.exceptions.RequestException as e:
        logger.error("HTTP error fetching topology: %s", e)
    except Exception as e:
        logger.exception("Unexpected error fetching topology: %s", e)
    return None


def fetch_pv_realtime(token: str, station_id: str, sn_code: str) -> list | None:
    """Fetch PV panel real-time info from MySigen API. Returns the data array or None."""
    url = f"{SIGEN_BASE_URL}/device/pvPanel/realTimeInfo"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": _USER_AGENT,
    }
    logger.debug("Fetching pvPanel/realTimeInfo station_id=%s snCode=%s", station_id, sn_code)
    try:
        resp = requests.get(
            url,
            headers=headers,
            params={"stationId": station_id, "snCode": sn_code},
            timeout=20,
        )
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("code") not in (0, "0", None):
            logger.error(
                "pvPanel/realTimeInfo API error code=%s msg=%s",
                payload.get("code"), payload.get("msg"),
            )
            return None
        data = payload.get("data")
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            # Wrap single-object response for uniform handling
            return [data]
        logger.warning("Unexpected data type from pvPanel/realTimeInfo: %s", type(data).__name__)
        return None
    except requests.exceptions.RequestException as e:
        logger.error("HTTP error fetching pvPanel/realTimeInfo: %s", e)
    except Exception as e:
        logger.exception("Unexpected error fetching pvPanel/realTimeInfo: %s", e)
    return None


def normalize_pv_data(data: list) -> dict[str, float]:
    """Parse the PV string array into a flat dict of normalized float fields."""
    fields: dict[str, float] = {}

    for pos, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        pv_idx = _infer_pv_index(item, pos)
        prefix = f"pv{pv_idx}"

        rt_list = item.get("realTimeInfoVOList", [])
        if not isinstance(rt_list, list):
            continue

        for entry in rt_list:
            if not isinstance(entry, dict):
                continue
            param_key = str(entry.get("paramKey", ""))
            param_value = entry.get("paramValue")
            suffix = _classify_param_key(param_key)
            if suffix is None:
                continue
            val = _parse_numeric(param_value)
            if val is not None:
                fields[f"{prefix}_{suffix}"] = val

    # Sum pv*_power fields into pv_total_power
    powers = [v for k, v in fields.items() if re.match(r"pv\d+_power$", k)]
    if powers:
        fields["pv_total_power"] = sum(powers)

    return fields


def write_to_influx(fields: dict[str, float], station_id: str, device_sn: str) -> bool:
    """Write normalized PV fields to pv_string_metrics measurement. Returns True on success."""
    if not fields:
        logger.info("No PV string fields to write; skipping InfluxDB write.")
        return False
    if not INFLUX_CLIENT_AVAILABLE:
        logger.error("influxdb-client unavailable; cannot write PV string metrics.")
        return False
    if not all([INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET]):
        logger.error("INFLUXDB_TOKEN, INFLUXDB_ORG, and INFLUXDB_BUCKET are required.")
        return False
    try:
        point = (
            Point("pv_string_metrics")
            .tag("station_id", station_id)
            .tag("device_sn", device_sn)
            .tag("source", "mysigen_pv_panel")
            .time(datetime.now(timezone.utc), WritePrecision.NS)
        )
        for key, value in fields.items():
            point = point.field(key, float(value))
        with InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG) as client:
            client.write_api(write_options=SYNCHRONOUS).write(bucket=INFLUX_BUCKET, record=point)
        logger.info(
            "Wrote pv_string_metrics station_id=%s device_sn=%s fields=%s",
            station_id, device_sn, sorted(fields),
        )
        return True
    except Exception as e:
        logger.exception("Error writing pv_string_metrics: %s", e)
        return False


def run_collector():
    station_id = SIGEN_STATION_ID.strip() if SIGEN_STATION_ID else ""
    if not station_id:
        logger.critical("SIGEN_STATION_ID is required but not configured. Exiting.")
        raise SystemExit(1)

    if not INFLUX_TOKEN:
        logger.warning("INFLUXDB_TOKEN is not set; InfluxDB writes will fail.")

    # Honour both env names; keep as None so we try discovery on first cycle
    aio_sn: str | None = (
        os.getenv("MYSIGEN_PV_AIO_SN") or os.getenv("SIGEN_PV_AIO_SN") or ""
    ).strip() or None

    logger.info(
        "MySigen PV string collector starting. station_id=%s interval=%ss sn_override=%s",
        station_id,
        MYSIGEN_PV_STRING_INTERVAL,
        aio_sn if aio_sn else "(auto-discover)",
    )

    failure_count = 0

    while True:
        cycle_start = time.time()
        cycle_ok = False

        try:
            token = get_active_sigen_access_token()
            if not token:
                logger.warning("No active Sigen token — skipping cycle.")
                failure_count += 1
            else:
                if not aio_sn:
                    aio_sn = discover_aio_sn(token, station_id)
                    if not aio_sn:
                        logger.error(
                            "AIO snCode discovery failed. "
                            "Set MYSIGEN_PV_AIO_SN or SIGEN_PV_AIO_SN and restart."
                        )
                        failure_count += 1
                        time.sleep(
                            max(0.0, MYSIGEN_PV_STRING_INTERVAL - (time.time() - cycle_start))
                        )
                        continue
                    logger.info("Using discovered AIO snCode=%s for all subsequent cycles.", aio_sn)

                data = fetch_pv_realtime(token, station_id, aio_sn)
                if data is not None:
                    fields = normalize_pv_data(data)
                    logger.info(
                        "Normalized PV fields: %s",
                        json.dumps({k: round(v, 4) for k, v in sorted(fields.items())}),
                    )
                    if fields:
                        cycle_ok = write_to_influx(fields, station_id, aio_sn)
                    else:
                        logger.warning("PV realTimeInfo returned no parseable numeric fields.")
                    if cycle_ok:
                        failure_count = 0
                    else:
                        failure_count += 1
                else:
                    failure_count += 1

        except Exception as e:
            failure_count += 1
            logger.exception("Unexpected error in collection cycle: %s", e)

        if failure_count > 0 and failure_count % 5 == 0:
            logger.warning("Consecutive failures: failure_count=%d", failure_count)

        elapsed = time.time() - cycle_start
        sleep_secs = max(0.0, MYSIGEN_PV_STRING_INTERVAL - elapsed)
        logger.debug("Cycle done ok=%s failures=%d sleep=%.1fs", cycle_ok, failure_count, sleep_secs)
        time.sleep(sleep_secs)


if __name__ == "__main__":
    logger.info("MySigen PV string collector starting (%s)", datetime.now(timezone.utc).isoformat())
    try:
        run_collector()
    except KeyboardInterrupt:
        logger.info("Received interrupt. Shutting down.")
    except SystemExit:
        raise
    except Exception as e:
        logger.exception("Fatal error: %s", e)
        raise SystemExit(1)
