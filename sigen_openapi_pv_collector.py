#!/usr/bin/env python3
"""Sigenergy Developer OpenAPI PV string-level collector.

Collects PV1-PV4 voltage/current/power from official Sigenergy Developer OpenAPI
when available and stores normalized data into the existing InfluxDB bucket.

Official endpoints used:
- POST /openapi/auth/login/key
- GET  /openapi/system
- GET  /openapi/system/{systemId}/devices
- GET  /openapi/systems/{systemId}/summary
- GET  /openapi/systems/{systemId}/energyFlow
- GET  /openapi/systems/{systemId}/devices/{serialNumber}/realtimeInfo

Fallback endpoint, disabled unless SIGEN_ENABLE_WEB_FALLBACK=true:
- GET /device/pvPanel/realTimeInfo?stationId=...&snCode=...
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import quote

import requests
from dotenv import load_dotenv
from logger import get_logger

try:
    from influxdb_client import InfluxDBClient, Point, WritePrecision
    from influxdb_client.client.write_api import SYNCHRONOUS
    INFLUX_CLIENT_AVAILABLE = True
except ImportError:  # pragma: no cover - import failure path for minimal installs
    INFLUX_CLIENT_AVAILABLE = False
    InfluxDBClient = None  # type: ignore
    Point = None  # type: ignore
    WritePrecision = None  # type: ignore
    SYNCHRONOUS = None  # type: ignore

load_dotenv()
logger = get_logger(__name__)

REGION_BASE_URLS = {
    "eu": "https://api-eu.sigencloud.com",
    "apac": "https://api-apac.sigencloud.com",
    "us": "https://api-us.sigencloud.com",
    "cn": "https://api-cn.sigencloud.com",
}

PV_FIELD_ALIASES = {
    1: {
        "voltage": ["pv1Voltage", "pV1Voltage", "pv1_voltage", "PV1Voltage", "pv1_volt"],
        "current": ["pv1Current", "pV1Current", "pv1_current", "PV1Current", "pv1_amp"],
        "power": ["pv1Power", "pV1Power", "pv1_power", "PV1Power", "pv1PowerW", "pv1_power_w"],
    },
    2: {
        "voltage": ["pv2Voltage", "pV2Voltage", "pv2_voltage", "PV2Voltage", "pv2_volt"],
        "current": ["pv2Current", "pV2Current", "pv2_current", "PV2Current", "pv2_amp"],
        "power": ["pv2Power", "pV2Power", "pv2_power", "PV2Power", "pv2PowerW", "pv2_power_w"],
    },
    3: {
        "voltage": ["pv3Voltage", "pV3Voltage", "pv3_voltage", "PV3Voltage", "pv3_volt"],
        "current": ["pv3Current", "pV3Current", "pv3_current", "PV3Current", "pv3_amp"],
        "power": ["pv3Power", "pV3Power", "pv3_power", "PV3Power", "pv3PowerW", "pv3_power_w"],
    },
    4: {
        "voltage": ["pv4Voltage", "pV4Voltage", "pv4_voltage", "PV4Voltage", "pv4_volt"],
        "current": ["pv4Current", "pV4Current", "pv4_current", "PV4Current", "pv4_amp"],
        "power": ["pv4Power", "pV4Power", "pv4_power", "PV4Power", "pv4PowerW", "pv4_power_w"],
    },
}

LIST_FIELD_NAMES = ["pvStringList", "stringList", "mpptList", "dcInputList"]


def env_bool(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def redact(value: str | None) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "***"
    return f"{value[:3]}…{value[-4:]}"


def parse_json_data(payload: dict[str, Any]) -> Any:
    data = payload.get("data")
    if isinstance(data, str):
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            return data
    return data


def flatten(obj: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(obj, dict):
        for key, val in obj.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            out.update(flatten(val, next_prefix))
    elif isinstance(obj, list):
        for idx, val in enumerate(obj):
            next_prefix = f"{prefix}[{idx}]"
            out.update(flatten(val, next_prefix))
    else:
        out[prefix] = obj
    return out


def deep_get_first(obj: Any, aliases: Iterable[str]) -> Any:
    aliases_set = {a.lower() for a in aliases}
    if isinstance(obj, dict):
        for key, value in obj.items():
            if str(key).lower() in aliases_set:
                return value
        for value in obj.values():
            hit = deep_get_first(value, aliases)
            if hit is not None:
                return hit
    elif isinstance(obj, list):
        for value in obj:
            hit = deep_get_first(value, aliases)
            if hit is not None:
                return hit
    return None


def iter_named_lists(obj: Any, names: Iterable[str]) -> Iterable[tuple[str, list[Any]]]:
    wanted = {n.lower() for n in names}
    if isinstance(obj, dict):
        for key, value in obj.items():
            if str(key).lower() in wanted and isinstance(value, list):
                yield str(key), value
            yield from iter_named_lists(value, names)
    elif isinstance(obj, list):
        for value in obj:
            yield from iter_named_lists(value, names)


def find_interesting_keys(obj: Any) -> list[str]:
    flat = flatten(obj)
    interesting = []
    patterns = [
        "pv1", "pv2", "pv3", "pv4", "pV1", "pV2", "pV3", "pV4",
        "pvStringList", "stringList", "mpptList", "dcInputList",
    ]
    for key in sorted(flat.keys()):
        if any(p.lower() in key.lower() for p in patterns):
            interesting.append(key)
    return interesting[:120]


@dataclass
class NormalizedPvStrings:
    timestamp: datetime
    station_id: str
    device_sn: str
    source: str
    fields: dict[str, float]
    official_has_string_fields: bool
    inspected_keys: list[str]


class SigenOpenApiClient:
    def __init__(self) -> None:
        self.region = os.getenv("SIGEN_REGION", "apac").strip().lower()
        self.base_url = os.getenv("SIGEN_OPENAPI_BASE_URL") or REGION_BASE_URLS.get(self.region, REGION_BASE_URLS["apac"])
        self.base_url = self.base_url.rstrip("/")
        self.app_key = os.getenv("SIGEN_APP_KEY")
        self.app_secret = os.getenv("SIGEN_APP_SECRET")
        self.access_token: str | None = None
        self.expires_at = 0.0
        self.session = requests.Session()
        self.timeout = int(os.getenv("SIGEN_OPENAPI_TIMEOUT", "20"))

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            path = "/" + path
        return self.base_url + path

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        url = self._url(path)
        headers = kwargs.pop("headers", {}) or {}
        if path != "/openapi/auth/login/key":
            token = self.get_token()
            headers["Authorization"] = f"Bearer {token}"
        headers.setdefault("Content-Type", "application/json")
        response = self.session.request(method, url, headers=headers, timeout=self.timeout, **kwargs)
        if response.status_code == 401 and path != "/openapi/auth/login/key":
            logger.warning("OpenAPI token rejected; refreshing and retrying once")
            self.access_token = None
            headers["Authorization"] = f"Bearer {self.get_token(force=True)}"
            response = self.session.request(method, url, headers=headers, timeout=self.timeout, **kwargs)
        response.raise_for_status()
        payload = response.json()
        code = payload.get("code")
        if code not in (0, "0", None):
            raise RuntimeError(f"OpenAPI {path} returned code={code} msg={payload.get('msg')}")
        return payload

    def get_token(self, force: bool = False) -> str:
        if not force and self.access_token and time.time() < self.expires_at - 60:
            return self.access_token
        if not self.app_key or not self.app_secret:
            raise RuntimeError("SIGEN_APP_KEY and SIGEN_APP_SECRET are required for Developer OpenAPI authentication")
        raw = f"{self.app_key}:{self.app_secret}".encode("utf-8")
        key = base64.b64encode(raw).decode("ascii")
        logger.info("Authenticating to Sigenergy Developer OpenAPI with AppKey %s", redact(self.app_key))
        payload = self._request_without_auth("POST", "/openapi/auth/login/key", json={"key": key})
        data = parse_json_data(payload) or {}
        token = data.get("accessToken") if isinstance(data, dict) else None
        expires = to_float(data.get("expiresIn")) if isinstance(data, dict) else None
        if not token:
            raise RuntimeError("OpenAPI authentication succeeded but no accessToken was returned")
        self.access_token = str(token)
        self.expires_at = time.time() + float(expires or 43199)
        return self.access_token

    def _request_without_auth(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = self.session.request(method, self._url(path), timeout=self.timeout, **kwargs)
        response.raise_for_status()
        payload = response.json()
        code = payload.get("code")
        if code not in (0, "0", None):
            raise RuntimeError(f"OpenAPI {path} returned code={code} msg={payload.get('msg')}")
        return payload

    def list_systems(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "/openapi/system")
        data = parse_json_data(payload)
        return data if isinstance(data, list) else []

    def list_devices(self, system_id: str) -> list[dict[str, Any]]:
        payload = self._request("GET", f"/openapi/system/{quote(system_id, safe='')}/devices")
        data = parse_json_data(payload)
        return data if isinstance(data, list) else []

    def system_summary(self, system_id: str) -> dict[str, Any] | None:
        payload = self._request("GET", f"/openapi/systems/{quote(system_id, safe='')}/summary")
        data = parse_json_data(payload)
        return data if isinstance(data, dict) else None

    def system_energy_flow(self, system_id: str) -> dict[str, Any] | None:
        payload = self._request("GET", f"/openapi/systems/{quote(system_id, safe='')}/energyFlow")
        data = parse_json_data(payload)
        return data if isinstance(data, dict) else None

    def device_realtime(self, system_id: str, device_sn: str) -> dict[str, Any] | None:
        path = f"/openapi/systems/{quote(system_id, safe='')}/devices/{quote(device_sn, safe='')}/realtimeInfo"
        payload = self._request("GET", path)
        data = parse_json_data(payload)
        return data if isinstance(data, dict) else None


def infer_device_sn(devices: list[dict[str, Any]], configured_sn: str | None) -> str | None:
    if configured_sn:
        return configured_sn
    preferred_types = {"inverter", "aio", "dccharger"}
    for device in devices:
        dtype = str(device.get("deviceType", "")).lower()
        if dtype in preferred_types or any(t in dtype for t in preferred_types):
            return str(device.get("serialNumber") or device.get("snCode") or "") or None
    for device in devices:
        sn = device.get("serialNumber") or device.get("snCode")
        if sn:
            return str(sn)
    return None


def normalize_pv_string_payload(payloads: list[tuple[str, Any]], station_id: str, device_sn: str) -> NormalizedPvStrings:
    merged: dict[str, Any] = {}
    inspected: list[str] = []
    source_names: list[str] = []
    for source, payload in payloads:
        if payload is None:
            continue
        source_names.append(source)
        flat = flatten(payload)
        for key, value in flat.items():
            merged.setdefault(key, value)
        inspected.extend([f"{source}:{key}" for key in find_interesting_keys(payload)])

    fields: dict[str, float] = {}
    official_has = False

    def get_alias_value(aliases: list[str]) -> float | None:
        value = deep_get_first([payload for _, payload in payloads], aliases)
        return to_float(value)

    for idx in range(1, 5):
        voltage = get_alias_value(PV_FIELD_ALIASES[idx]["voltage"])
        current = get_alias_value(PV_FIELD_ALIASES[idx]["current"])
        power = get_alias_value(PV_FIELD_ALIASES[idx]["power"])
        if power is None and voltage is not None and current is not None:
            # Official realtime returns kW for pvPower and V/A for string V/I.
            power = voltage * current / 1000.0
        if voltage is not None:
            fields[f"pv{idx}_voltage"] = voltage
            official_has = True
        if current is not None:
            fields[f"pv{idx}_current"] = current
            official_has = True
        if power is not None:
            fields[f"pv{idx}_power"] = power
            official_has = True

    # Support list-shaped payloads if Sigenergy adds pvStringList/stringList/mpptList/dcInputList.
    for _, payload in payloads:
        for _name, items in iter_named_lists(payload, LIST_FIELD_NAMES):
            for pos, item in enumerate(items[:4], start=1):
                if not isinstance(item, dict):
                    continue
                voltage = to_float(deep_get_first(item, ["voltage", "pvVoltage", "stringVoltage", "dcVoltage", "u"]))
                current = to_float(deep_get_first(item, ["current", "pvCurrent", "stringCurrent", "dcCurrent", "i"]))
                power = to_float(deep_get_first(item, ["power", "pvPower", "stringPower", "dcPower", "p"]))
                if power is None and voltage is not None and current is not None:
                    power = voltage * current / 1000.0
                if voltage is not None:
                    fields[f"pv{pos}_voltage"] = voltage
                    official_has = True
                if current is not None:
                    fields[f"pv{pos}_current"] = current
                    official_has = True
                if power is not None:
                    fields[f"pv{pos}_power"] = power
                    official_has = True

    total = get_alias_value(["pvTotalPower", "pvPower", "pVPower", "pvPowerW", "pv_total_power"])
    if total is None:
        powers = [fields.get(f"pv{i}_power") for i in range(1, 5)]
        numeric_powers = [p for p in powers if p is not None]
        if numeric_powers:
            total = sum(numeric_powers)
    if total is not None:
        fields["pv_total_power"] = total

    return NormalizedPvStrings(
        timestamp=datetime.now(timezone.utc),
        station_id=station_id,
        device_sn=device_sn,
        source="+".join(source_names) or "none",
        fields=fields,
        official_has_string_fields=official_has,
        inspected_keys=sorted(set(inspected)),
    )


def get_web_fallback(station_id: str, device_sn: str) -> dict[str, Any] | None:
    if not env_bool("SIGEN_ENABLE_WEB_FALLBACK", False):
        return None
    base = os.getenv("SIGEN_WEB_BASE_URL") or os.getenv("SIGEN_BASE_URL") or REGION_BASE_URLS.get(os.getenv("SIGEN_REGION", "apac"), REGION_BASE_URLS["apac"])
    token = os.getenv("SIGEN_WEB_ACCESS_TOKEN")
    cookie = os.getenv("SIGEN_WEB_COOKIE")
    if not token and not cookie:
        logger.warning("Web fallback enabled but SIGEN_WEB_ACCESS_TOKEN or SIGEN_WEB_COOKIE is not set")
        return None
    headers = {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 SigenOpenApiPvCollector/1.0",
    }
    if token:
        headers["Authorization"] = token if token.lower().startswith("bearer ") else f"Bearer {token}"
    if cookie:
        headers["Cookie"] = cookie
    url = base.rstrip("/") + "/device/pvPanel/realTimeInfo"
    logger.info("Calling MySigen Web fallback for station=%s device=%s", station_id, device_sn)
    response = requests.get(url, headers=headers, params={"stationId": station_id, "snCode": device_sn}, timeout=20)
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and payload.get("code") not in (0, "0", None):
        raise RuntimeError(f"Web fallback returned code={payload.get('code')} msg={payload.get('msg')}")
    data = parse_json_data(payload) if isinstance(payload, dict) else payload
    return data if isinstance(data, dict) else {"data": data}


def write_pv_strings_to_influx(normalized: NormalizedPvStrings) -> bool:
    if not normalized.fields:
        logger.info("No PV string numeric fields found; skipping InfluxDB write")
        return False
    if not INFLUX_CLIENT_AVAILABLE:
        logger.error("influxdb-client package unavailable; cannot write PV string metrics")
        return False
    influx_url = os.getenv("INFLUXDB_URL", "http://localhost:8086")
    influx_token = os.getenv("INFLUXDB_TOKEN")
    influx_org = os.getenv("INFLUXDB_ORG")
    influx_bucket = os.getenv("INFLUXDB_BUCKET")
    if not all([influx_token, influx_org, influx_bucket]):
        logger.error("INFLUXDB_TOKEN, INFLUXDB_ORG, and INFLUXDB_BUCKET are required")
        return False
    point = (
        Point("pv_string_metrics")
        .tag("station_id", normalized.station_id)
        .tag("device_sn", normalized.device_sn)
        .tag("source", normalized.source)
        .time(normalized.timestamp, WritePrecision.NS)
    )
    for key, value in normalized.fields.items():
        point = point.field(key, float(value))
    with InfluxDBClient(url=influx_url, token=influx_token, org=influx_org) as client:
        client.write_api(write_options=SYNCHRONOUS).write(bucket=influx_bucket, record=point)
    logger.info("Wrote pv_string_metrics for station=%s device=%s fields=%s", normalized.station_id, normalized.device_sn, sorted(normalized.fields))
    return True


def collect_once(write: bool = True, discover_only: bool = False) -> NormalizedPvStrings | None:
    client = SigenOpenApiClient()
    configured_system = os.getenv("SIGEN_SYSTEM_ID")
    configured_device = os.getenv("SIGEN_DEVICE_SN")

    systems = client.list_systems()
    logger.info("Discovered %d authorized system(s)", len(systems))
    for system in systems[:20]:
        logger.info("System discovered: id=%s name=%s status=%s timezone=%s", system.get("systemId"), system.get("systemName"), system.get("status"), system.get("timeZone"))

    system_id = configured_system or (str(systems[0].get("systemId")) if systems else None)
    if not system_id:
        raise RuntimeError("No SIGEN_SYSTEM_ID configured and OpenAPI system list was empty")

    devices = client.list_devices(system_id)
    logger.info("Discovered %d device(s) under system=%s", len(devices), system_id)
    for device in devices[:30]:
        logger.info("Device discovered: sn=%s type=%s status=%s pvStringNumber=%s", device.get("serialNumber"), device.get("deviceType"), device.get("status"), (device.get("attrMap") or {}).get("pvStringNumber"))

    device_sn = infer_device_sn(devices, configured_device)
    if not device_sn:
        raise RuntimeError("No SIGEN_DEVICE_SN configured and no device serial number could be inferred")

    if discover_only:
        return None

    payloads: list[tuple[str, Any]] = []
    for name, fn in [
        ("system_summary", lambda: client.system_summary(system_id)),
        ("system_energy_flow", lambda: client.system_energy_flow(system_id)),
        ("device_realtime", lambda: client.device_realtime(system_id, device_sn)),
    ]:
        try:
            data = fn()
            payloads.append((name, data))
            logger.info("%s interesting PV keys: %s", name, find_interesting_keys(data))
        except Exception as exc:
            logger.warning("%s call failed: %s", name, exc)

    normalized = normalize_pv_string_payload(payloads, system_id, device_sn)

    if not normalized.official_has_string_fields:
        logger.warning("Official OpenAPI responses did not expose PV1-PV4/string-list fields. Telemetry Push docs indicate customizable telemetry topics may be required; check Data Subscription topic content in Developer Control Center.")
        fallback = get_web_fallback(system_id, device_sn)
        if fallback is not None:
            fallback_norm = normalize_pv_string_payload([("web_fallback", fallback)], system_id, device_sn)
            if fallback_norm.fields:
                normalized = fallback_norm

    logger.info("Normalized PV string output: %s", json.dumps({
        "timestamp": normalized.timestamp.isoformat(),
        "station_id": normalized.station_id,
        "device_sn": normalized.device_sn,
        **normalized.fields,
    }, sort_keys=True))
    if normalized.inspected_keys:
        logger.info("Inspected interesting keys: %s", normalized.inspected_keys)

    if write:
        write_pv_strings_to_influx(normalized)
    return normalized


def validate_environment() -> list[str]:
    missing = []
    for key in ["SIGEN_APP_KEY", "SIGEN_APP_SECRET"]:
        if not os.getenv(key):
            missing.append(key)
    for key in ["INFLUXDB_TOKEN", "INFLUXDB_ORG", "INFLUXDB_BUCKET"]:
        if not os.getenv(key):
            missing.append(key)
    return missing


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect Sigenergy Developer OpenAPI PV string metrics into InfluxDB")
    parser.add_argument("--once", action="store_true", help="Run one collection cycle and exit")
    parser.add_argument("--discover-only", action="store_true", help="Authenticate and list systems/devices only; do not collect or write")
    parser.add_argument("--dry-run", action="store_true", help="Collect and normalize but do not write to InfluxDB")
    parser.add_argument("--check-env", action="store_true", help="Validate required environment variables and exit")
    args = parser.parse_args()

    missing = validate_environment()
    if args.check_env:
        if missing:
            logger.error("Missing required environment variables: %s", ", ".join(missing))
            return 2
        logger.info("Required environment variables are present")
        return 0
    if missing:
        logger.error("Missing required environment variables: %s", ", ".join(missing))
        return 2

    interval = int(os.getenv("SIGEN_OPENAPI_PV_INTERVAL", os.getenv("SLEEP_INTERVAL", "300")))
    if args.once or args.discover_only:
        collect_once(write=not args.dry_run and not args.discover_only, discover_only=args.discover_only)
        return 0

    logger.info("Starting Sigenergy OpenAPI PV collector interval=%ss", interval)
    while True:
        try:
            collect_once(write=not args.dry_run)
        except Exception as exc:
            logger.exception("Collection cycle failed: %s", exc)
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
