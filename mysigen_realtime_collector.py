import os
import time
import json
from datetime import datetime, timezone
from dotenv import load_dotenv
from logger import get_logger

logger = get_logger(__name__)

load_dotenv()

SIGEN_STATION_ID = os.getenv("SIGEN_STATION_ID")
SIGEN_BASE_URL = os.getenv("SIGEN_BASE_URL", "https://api-eu.sigencloud.com")
MYSIGEN_REALTIME_INTERVAL = int(os.getenv("MYSIGEN_REALTIME_INTERVAL", "15"))
MYSIGEN_STATION_INFO_INTERVAL = int(os.getenv("MYSIGEN_STATION_INFO_INTERVAL", "3600"))
INFLUX_TOKEN = os.getenv("INFLUXDB_TOKEN")

_STATION_ID_CANDIDATE_KEYS = ["stationId", "id", "stationID", "station_id", "siteId"]

try:
    from auth_handler import get_active_sigen_access_token
    from sigen_api_client import fetch_sigen_energy_flow, fetch_sigen_station_info
    from influxdb_writer import (
        write_energy_flow_to_influxdb,
        write_raw_snapshot_to_influxdb,
        write_collector_health_to_influxdb,
        write_station_info_to_influxdb,
    )
except ImportError as e:
    logger.critical(f"Could not import required modules: {e}")
    raise SystemExit(1)


class ExponentialBackoff:
    def __init__(self, base_interval, factor=2, max_wait=300):
        self.base_interval = base_interval
        self.factor = factor
        self.max_wait = max_wait
        self.failures = 0

    def reset(self):
        self.failures = 0

    def record_failure(self):
        self.failures += 1

    def sleep_seconds(self):
        if self.failures == 0:
            return self.base_interval
        return min(self.base_interval * (self.factor ** self.failures), self.max_wait)


def _discover_station_id(token):
    """Attempt to discover station_id from the station_info API response."""
    logger.info("SIGEN_STATION_ID not set — attempting discovery via station_info endpoint...")
    try:
        data = fetch_sigen_station_info(token, SIGEN_BASE_URL)
    except Exception as e:
        logger.error(f"Station info fetch failed during discovery: {e}")
        return None
    if not data:
        return None

    candidates = [data] if isinstance(data, dict) else (data if isinstance(data, list) else [])
    for item in candidates:
        if not isinstance(item, dict):
            continue
        for key in _STATION_ID_CANDIDATE_KEYS:
            val = item.get(key)
            if val:
                sid = str(val).strip()
                if sid:
                    logger.info(f"Discovered station_id from key '{key}': {sid}")
                    return sid

    available = list(data.keys()) if isinstance(data, dict) else type(data).__name__
    logger.error(f"Could not find station_id in station_info response. Available keys: {available}")
    return None


def _normalize_energy_flow(raw_data):
    """Normalize raw API energy flow to the same field mapping used by main_scheduler."""
    _buy_sell_raw = raw_data.get("buySellPower")
    try:
        _grid_idle = 1 if abs(float(_buy_sell_raw)) <= 0.05 else 0
    except (TypeError, ValueError):
        _grid_idle = None

    on_grid_raw = raw_data.get("onGrid")
    if on_grid_raw is True:
        on_grid = 1
    elif on_grid_raw is False:
        on_grid = 0
    else:
        on_grid = None

    payload = {
        "pv_day_nrg": raw_data.get("pvDayNrg"),
        "pv_power": raw_data.get("pvPower"),
        "load_power": raw_data.get("loadPower"),
        "battery_soc": raw_data.get("batterySoc"),
        "grid_flow_power": _buy_sell_raw,
        "battery_power": raw_data.get("batteryPower"),
        "on_grid": on_grid,
        "station_status": raw_data.get("stationStatus"),
        "on_off_grid_status": raw_data.get("onOffGridStatus"),
        "ac_power": raw_data.get("acPower"),
        "ev_power": raw_data.get("evPower"),
        "generator_power": raw_data.get("generatorPower"),
        "heat_pump_power": raw_data.get("heatPumpPower"),
        "third_pv_power": raw_data.get("thirdPvPower"),
        "grid_idle": _grid_idle,
    }
    return {k: v for k, v in payload.items() if v is not None}


def run_collector():
    station_id = SIGEN_STATION_ID.strip() if SIGEN_STATION_ID else ""

    if not INFLUX_TOKEN:
        logger.warning("INFLUXDB_TOKEN is not set. InfluxDB writes will fail.")

    if not station_id:
        logger.warning("SIGEN_STATION_ID not configured — attempting discovery.")
        token = get_active_sigen_access_token()
        if not token:
            logger.critical("Cannot acquire auth token for station ID discovery. Exiting.")
            raise SystemExit(1)
        station_id = _discover_station_id(token)
        if not station_id:
            logger.critical(
                "Could not determine SIGEN_STATION_ID automatically. "
                "Please set it explicitly in your .env file and restart."
            )
            raise SystemExit(1)
        logger.info(f"Using discovered station_id: {station_id}")

    logger.info(
        f"MySigen realtime collector started. "
        f"station_id={station_id}, "
        f"poll_interval={MYSIGEN_REALTIME_INTERVAL}s, "
        f"station_info_interval={MYSIGEN_STATION_INFO_INTERVAL}s"
    )

    failure_count = 0
    last_success_ts = None
    last_station_info_ts = 0.0
    backoff = ExponentialBackoff(base_interval=MYSIGEN_REALTIME_INTERVAL)

    while True:
        cycle_start = time.time()
        cycle_ok = False

        try:
            token = get_active_sigen_access_token()
            if not token:
                logger.warning("No active Sigen token — skipping collection cycle.")
                failure_count += 1
                backoff.record_failure()
            else:
                raw_data = fetch_sigen_energy_flow(token, SIGEN_BASE_URL, station_id)
                if raw_data is not None:
                    normalized = _normalize_energy_flow(raw_data)
                    if normalized:
                        try:
                            write_energy_flow_to_influxdb(normalized, station_id)
                        except Exception as e:
                            logger.error(f"Failed to write energy_metrics: {e}")

                    # Raw snapshot contains only the API response data, never auth credentials.
                    try:
                        write_raw_snapshot_to_influxdb(
                            payload_json=json.dumps(raw_data),
                            station_id_tag=station_id,
                            endpoint="energyflow",
                        )
                    except Exception as e:
                        logger.error(f"Failed to write raw snapshot: {e}")

                    last_success_ts = time.time()
                    failure_count = 0
                    backoff.reset()
                    cycle_ok = True
                else:
                    failure_count += 1
                    backoff.record_failure()
                    logger.warning(f"Energy flow fetch returned None. consecutive_failures={failure_count}")

                now = time.time()
                if now - last_station_info_ts >= MYSIGEN_STATION_INFO_INTERVAL:
                    try:
                        station_data = fetch_sigen_station_info(token, SIGEN_BASE_URL)
                        if station_data is not None:
                            write_station_info_to_influxdb(station_data, station_id)
                            last_station_info_ts = now
                    except Exception as e:
                        logger.error(f"Failed during station_info fetch/write: {e}")

        except Exception as e:
            failure_count += 1
            backoff.record_failure()
            logger.exception(f"Unexpected error in collector cycle: {e}")

        try:
            write_collector_health_to_influxdb(
                health_data={
                    "failure_count": float(failure_count),
                    "last_success_ts": float(last_success_ts) if last_success_ts else 0.0,
                    "cycle_ok": 1.0 if cycle_ok else 0.0,
                },
                station_id_tag=station_id,
            )
        except Exception as e:
            logger.error(f"Failed to write collector health: {e}")

        elapsed = time.time() - cycle_start
        sleep_secs = max(0.0, backoff.sleep_seconds() - elapsed)
        logger.debug(f"Cycle complete. ok={cycle_ok}, failures={failure_count}, sleep={sleep_secs:.1f}s")
        time.sleep(sleep_secs)


if __name__ == "__main__":
    logger.info(f"MySigen Realtime Collector starting ({datetime.now(timezone.utc).isoformat()})")
    try:
        run_collector()
    except KeyboardInterrupt:
        logger.info("Received interrupt. Shutting down.")
    except SystemExit:
        raise
    except Exception as e:
        logger.exception(f"Fatal error: {e}")
        raise SystemExit(1)
