#!/usr/bin/env python3
"""Read-only Tesla Fleet API collector for InfluxDB.

This collector uses only Python stdlib modules. It reads an existing Tesla OAuth
token file, polls vehicle data, and writes a small set of numeric measurements to
InfluxDB line protocol.
"""

from __future__ import annotations

import fcntl
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_TESLA_API_HOST = "https://fleet-api.prd.eu.vn.cloud.tesla.com"
DEFAULT_TESLA_TOKEN_URL = "https://auth.tesla.com/oauth2/v3/token"
DEFAULT_TESLA_OAUTH_SCOPE = "openid offline_access vehicle_device_data"

INFLUXDB_URL = os.getenv("INFLUXDB_URL", "http://localhost:8086").rstrip("/")
INFLUXDB_TOKEN = os.getenv("INFLUXDB_TOKEN", "")
INFLUXDB_ORG = os.getenv("INFLUXDB_ORG", "sigorg")
INFLUXDB_BUCKET = os.getenv("INFLUXDB_BUCKET", "energy_metrics")
TESLA_API_BASE = os.getenv("TESLA_API_BASE", os.getenv("TESLA_API_HOST", DEFAULT_TESLA_API_HOST)).rstrip("/")
TESLA_API_HOST = TESLA_API_BASE
TESLA_TOKEN_FILE = pathlib.Path(os.getenv("TESLA_TOKEN_FILE", "/data/tesla_oauth_token.json"))
TESLA_TOKEN_URL = os.getenv("TESLA_TOKEN_URL", DEFAULT_TESLA_TOKEN_URL).strip()
TESLA_CLIENT_ID = os.getenv("TESLA_CLIENT_ID", "").strip()
TESLA_CLIENT_SECRET = os.getenv("TESLA_CLIENT_SECRET", "")
TESLA_REFRESH_SKEW_SECONDS = int(os.getenv("TESLA_REFRESH_SKEW_SECONDS", "300"))
TESLA_OAUTH_SCOPE = os.getenv("TESLA_OAUTH_SCOPE", DEFAULT_TESLA_OAUTH_SCOPE).strip()
TESLA_VIN = os.getenv("TESLA_VIN", "").strip()
TESLA_WAKE_ALLOWED = os.getenv("TESLA_WAKE_ALLOWED", "false").strip().lower() in {"1", "true", "yes", "on"}
TESLA_POLL_IDLE_SECONDS = int(os.getenv("TESLA_POLL_IDLE_SECONDS", "900"))
TESLA_POLL_CHARGING_SECONDS = int(os.getenv("TESLA_POLL_CHARGING_SECONDS", "60"))

CHARGING_STATE_CODES = {
    "Disconnected": 0,
    "Complete": 1,
    "Charging": 2,
    "Starting": 3,
    "Stopped": 4,
    "NoPower": 5,
}

VEHICLE_STATE_CODES = {
    "offline": 0,
    "online": 1,
    "asleep": 2,
    "waking": 3,
}


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}", flush=True)


def to_float(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return float(int(value))
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_int(value):
    n = to_float(value)
    if n is None:
        return None
    return int(n)


def sanitize_tag_value(value: str) -> str:
    raw = str(value or "unknown")
    chars = []
    for ch in raw:
        if ch.isalnum() or ch in {"_", "-", "."}:
            chars.append(ch)
        else:
            chars.append("_")
    sanitized = "".join(chars).strip("_")
    return sanitized or "unknown"


def vin_suffix(vehicle: dict) -> str:
    vin = str(vehicle.get("vin") or "")
    return sanitize_tag_value(vin[-6:] if len(vin) >= 6 else "unknown")


def vehicle_name(vehicle: dict) -> str:
    display = vehicle.get("display_name") or vehicle.get("vehicle_name") or "unknown"
    return sanitize_tag_value(str(display))


def escape_measurement(value: str) -> str:
    return value.replace("\\", "\\\\").replace(" ", "\\ ").replace(",", "\\,")


def escape_tag(value: str) -> str:
    return value.replace("\\", "\\\\").replace(" ", "\\ ").replace(",", "\\,").replace("=", "\\=")


def field_value(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return "1i" if value else "0i"
    if isinstance(value, int):
        return f"{value}i"
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return repr(value)
    return None


def line_protocol(measurement: str, tags: dict, fields: dict, timestamp_ns: int) -> str | None:
    clean_fields = []
    for key, value in fields.items():
        encoded = field_value(value)
        if encoded is not None:
            clean_fields.append(f"{escape_measurement(key)}={encoded}")
    if not clean_fields:
        return None

    tag_part = "".join(
        f",{escape_tag(str(k))}={escape_tag(str(v))}"
        for k, v in sorted(tags.items())
        if v is not None and str(v) != ""
    )
    return f"{escape_measurement(measurement)}{tag_part} {','.join(clean_fields)} {timestamp_ns}"


def http_json(method: str, url: str, token: str | None = None, body: bytes | None = None) -> dict:
    headers = {
        "Accept": "application/json",
        "User-Agent": "sig-data-tesla-fleet-collector/1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def token_lock_file() -> pathlib.Path:
    return TESLA_TOKEN_FILE.with_name(f"{TESLA_TOKEN_FILE.name}.lock")


def load_token_payload() -> dict:
    if not TESLA_TOKEN_FILE.exists():
        raise RuntimeError(f"Tesla token file not found at {TESLA_TOKEN_FILE}")
    payload = json.loads(TESLA_TOKEN_FILE.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("Tesla token file does not contain a JSON object")
    return payload


def token_expires_at(payload: dict) -> float | None:
    expires_at = to_float(payload.get("expires_at"))
    if expires_at is None:
        created_at = to_float(payload.get("created_at") or payload.get("obtained_at"))
        expires_in = to_float(payload.get("expires_in"))
        if created_at is not None and expires_in is not None:
            expires_at = created_at + expires_in
    if expires_at is not None and expires_at > 10_000_000_000:
        expires_at = expires_at / 1000
    return expires_at


def access_token_is_valid(payload: dict, now: float | None = None) -> bool:
    token = payload.get("access_token")
    if not token:
        return False
    expires_at = token_expires_at(payload)
    if expires_at is None:
        return False
    return (now if now is not None else time.time()) < expires_at - TESLA_REFRESH_SKEW_SECONDS


def require_refresh_inputs(payload: dict) -> tuple[str, str, str]:
    refresh_token = str(payload.get("refresh_token") or "").strip()
    missing = []
    if not TESLA_CLIENT_ID:
        missing.append("TESLA_CLIENT_ID")
    if not TESLA_CLIENT_SECRET:
        missing.append("TESLA_CLIENT_SECRET")
    if not refresh_token:
        missing.append("refresh_token in Tesla token file")
    if missing:
        raise RuntimeError(f"Tesla OAuth token refresh cannot run; missing {', '.join(missing)}")
    return TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, refresh_token


def atomic_save_token_payload(payload: dict) -> None:
    TESLA_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp_file = TESLA_TOKEN_FILE.with_name(f"{TESLA_TOKEN_FILE.name}.{os.getpid()}.tmp")
    data = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    fd = os.open(tmp_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_file, TESLA_TOKEN_FILE)
        os.chmod(TESLA_TOKEN_FILE, 0o600)
    finally:
        try:
            tmp_file.unlink()
        except FileNotFoundError:
            pass


def request_token_refresh(payload: dict) -> dict:
    client_id, client_secret, refresh_token = require_refresh_inputs(payload)
    form = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
    }
    if TESLA_OAUTH_SCOPE:
        form["scope"] = TESLA_OAUTH_SCOPE
    if payload.get("audience"):
        form["audience"] = str(payload.get("audience"))

    body = urllib.parse.urlencode(form).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "sig-data-tesla-fleet-collector/1.0",
    }
    req = urllib.request.Request(TESLA_TOKEN_URL, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"Tesla OAuth token refresh failed with HTTP status {err.code}") from err
    except urllib.error.URLError as err:
        raise RuntimeError("Tesla OAuth token refresh failed because the token endpoint was unreachable") from err
    response = json.loads(raw) if raw else {}
    if not isinstance(response, dict) or not response.get("access_token"):
        raise RuntimeError("Tesla OAuth token refresh response did not include access_token")
    return response


def refreshed_token_payload(old_payload: dict, refresh_response: dict, obtained_at: float) -> dict:
    next_payload = dict(old_payload)
    next_payload.update(refresh_response)
    if not refresh_response.get("refresh_token") and old_payload.get("refresh_token"):
        next_payload["refresh_token"] = old_payload["refresh_token"]
    if old_payload.get("audience") and not refresh_response.get("audience"):
        next_payload["audience"] = old_payload["audience"]

    next_payload["obtained_at"] = int(obtained_at)
    expires_in = to_float(refresh_response.get("expires_in"))
    if expires_in is not None:
        next_payload["expires_at"] = int(obtained_at + expires_in)
    else:
        expires_at = to_float(refresh_response.get("expires_at"))
        if expires_at is None:
            raise RuntimeError("Tesla OAuth token refresh response did not include token expiry")
        if expires_at > 10_000_000_000:
            expires_at = expires_at / 1000
        next_payload["expires_at"] = int(expires_at)
    return next_payload


def ensure_access_token() -> str:
    payload = load_token_payload()
    if access_token_is_valid(payload):
        return str(payload["access_token"])

    lock_path = token_lock_file()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a", encoding="utf-8") as lock_fh:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
        payload = load_token_payload()
        if access_token_is_valid(payload):
            return str(payload["access_token"])

        response = request_token_refresh(payload)
        obtained_at = time.time()
        updated_payload = refreshed_token_payload(payload, response, obtained_at)
        atomic_save_token_payload(updated_payload)
        log("Tesla OAuth access token refreshed")
        token = updated_payload.get("access_token")
        if not token:
            raise RuntimeError("Tesla OAuth token refresh did not produce a usable access token")
        return str(token)


def load_access_token() -> str:
    return ensure_access_token()


def write_influx(lines: list[str]) -> bool:
    if not lines:
        return False
    if not INFLUXDB_TOKEN or not INFLUXDB_ORG or not INFLUXDB_BUCKET:
        log("InfluxDB env is incomplete; skipping write")
        return False

    params = urllib.parse.urlencode({"org": INFLUXDB_ORG, "bucket": INFLUXDB_BUCKET, "precision": "ns"})
    url = f"{INFLUXDB_URL}/api/v2/write?{params}"
    body = ("\n".join(lines) + "\n").encode("utf-8")
    headers = {
        "Authorization": f"Token {INFLUXDB_TOKEN}",
        "Content-Type": "text/plain; charset=utf-8",
        "User-Agent": "sig-data-tesla-fleet-collector/1.0",
    }
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        resp.read()
    return True


def list_vehicles(token: str) -> list[dict]:
    payload = http_json("GET", f"{TESLA_API_HOST}/api/1/vehicles", token=token)
    data = payload.get("response")
    return data if isinstance(data, list) else []


def select_vehicle(vehicles: list[dict]) -> dict | None:
    if TESLA_VIN:
        for vehicle in vehicles:
            if str(vehicle.get("vin") or "") == TESLA_VIN:
                return vehicle
        return None
    return vehicles[0] if vehicles else None


def vehicle_identifier(vehicle: dict) -> str:
    return str(vehicle.get("id_s") or vehicle.get("id") or "")


def fetch_vehicle_data(token: str, vehicle: dict) -> dict:
    vehicle_id = vehicle_identifier(vehicle)
    if not vehicle_id:
        raise RuntimeError("Selected Tesla vehicle has no id_s or id")
    payload = http_json("GET", f"{TESLA_API_HOST}/api/1/vehicles/{urllib.parse.quote(vehicle_id)}/vehicle_data", token=token)
    response = payload.get("response")
    return response if isinstance(response, dict) else {}


def base_tags(vehicle: dict | None) -> dict:
    return {
        "source": "tesla_fleet_api",
        "vin_suffix": vin_suffix(vehicle or {}),
        "vehicle_name": vehicle_name(vehicle or {}),
    }


def health_line(vehicle: dict | None, cycle_ok: int, failure_count: int, vehicle_online_flag: int, selected_present: int) -> str | None:
    return line_protocol(
        "tesla_collector_health",
        base_tags(vehicle),
        {
            "cycle_ok": cycle_ok,
            "failure_count": failure_count,
            "vehicle_online": vehicle_online_flag,
            "selected_vehicle_present": selected_present,
        },
        time.time_ns(),
    )


def build_vehicle_lines(vehicle: dict, data: dict, failure_count: int) -> tuple[list[str], bool]:
    tags = base_tags(vehicle)
    charge = data.get("charge_state") if isinstance(data.get("charge_state"), dict) else {}
    state = data.get("vehicle_state") if isinstance(data.get("vehicle_state"), dict) else {}
    vehicle_api_state = str(data.get("state") or vehicle.get("state") or "unknown")
    charging_state = str(charge.get("charging_state") or "unknown")
    ts = time.time_ns()

    charge_fields = {
        "battery_level_pct": to_int(charge.get("battery_level")),
        "charge_limit_soc_pct": to_int(charge.get("charge_limit_soc")),
        "charger_power_kw": to_float(charge.get("charger_power")),
        "charge_energy_added_kwh": to_float(charge.get("charge_energy_added")),
        "time_to_full_hours": to_float(charge.get("time_to_full_charge")),
        "charge_port_door_open_bool": 1 if charge.get("charge_port_door_open") is True else 0 if charge.get("charge_port_door_open") is False else None,
        "charging_state_code": CHARGING_STATE_CODES.get(charging_state, -1),
        "estimated_range_mi": to_float(charge.get("est_battery_range")),
        "usable_battery_level_pct": to_int(charge.get("usable_battery_level")),
    }
    vehicle_fields = {
        "vehicle_online": 1 if vehicle_api_state == "online" else 0,
        "odometer_mi": to_float(state.get("odometer")),
        "vehicle_state_code": VEHICLE_STATE_CODES.get(vehicle_api_state, -1),
    }
    lines = [
        line_protocol("tesla_charge_state", tags, charge_fields, ts),
        line_protocol("tesla_vehicle_state", tags, vehicle_fields, ts),
        health_line(vehicle, 1, failure_count, 1 if vehicle_api_state == "online" else 0, 1),
    ]
    return [line for line in lines if line], charging_state == "Charging"


def run_cycle(failure_count: int) -> tuple[int, int]:
    token = ensure_access_token()
    vehicles = list_vehicles(token)
    vehicle = select_vehicle(vehicles)
    if vehicle is None:
        log("No selected Tesla vehicle found")
        line = health_line(None, 0, failure_count + 1, 0, 0)
        if line:
            write_influx([line])
        return failure_count + 1, TESLA_POLL_IDLE_SECONDS

    state = str(vehicle.get("state") or "unknown")
    suffix = vin_suffix(vehicle)
    if state != "online":
        if TESLA_WAKE_ALLOWED:
            log(f"Tesla vehicle suffix {suffix} is {state}; wake_up requested but not implemented in this read-only version")
        else:
            log(f"Tesla vehicle suffix {suffix} is {state}; wake disabled")
        line = health_line(vehicle, 1, failure_count, 0, 1)
        if line:
            write_influx([line])
        return failure_count, TESLA_POLL_IDLE_SECONDS

    data = fetch_vehicle_data(token, vehicle)
    lines, is_charging = build_vehicle_lines(vehicle, data, failure_count)
    write_influx(lines)
    interval = TESLA_POLL_CHARGING_SECONDS if is_charging else TESLA_POLL_IDLE_SECONDS
    log(f"Tesla vehicle suffix {suffix} poll ok; charging={is_charging}; next_poll_seconds={interval}")
    return 0, interval


def main() -> None:
    log(f"Starting Tesla Fleet collector host={TESLA_API_HOST}")
    if TESLA_WAKE_ALLOWED:
        log("TESLA_WAKE_ALLOWED is true, but wake_up is not implemented and will not be called")
    failure_count = 0
    while True:
        try:
            failure_count, sleep_seconds = run_cycle(failure_count)
        except urllib.error.HTTPError as err:
            failure_count += 1
            log(f"Tesla collector HTTP error status={err.code}; failure_count={failure_count}")
            line = health_line(None, 0, failure_count, 0, 0)
            if line:
                try:
                    write_influx([line])
                except Exception as write_err:
                    log(f"Failed writing Tesla health after HTTP error: {write_err}")
            sleep_seconds = TESLA_POLL_IDLE_SECONDS
        except Exception as err:
            failure_count += 1
            log(f"Tesla collector error: {err}; failure_count={failure_count}")
            line = health_line(None, 0, failure_count, 0, 0)
            if line:
                try:
                    write_influx([line])
                except Exception as write_err:
                    log(f"Failed writing Tesla health after error: {write_err}")
            sleep_seconds = TESLA_POLL_IDLE_SECONDS
        time.sleep(max(1, int(sleep_seconds)))


if __name__ == "__main__":
    main()
