"""Agent configuration from /etc/kiosk/config.yaml (spec §7)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import yaml


@dataclass
class AgentConfig:
    kiosk_id: str
    kiosk_secret: str
    api_url: str
    printer_ip: str
    printer_queue_name: str = "L15150"
    display_port: int = 8080
    tmp_dir: str = "/dev/shm/kiosk"  # never write user files to persistent disk
    agent_version: str = "0.1.0"
    # SNMP ink polling (Epson private MIB differs per firmware; if unreliable
    # we fall back to IPP marker-levels — spec §7 printer.py)
    snmp_oids: dict[str, str] = field(
        default_factory=lambda: {
            "black": "1.3.6.1.4.1.1248.1.2.2.54.1.3.1.2.1",
            "cyan": "1.3.6.1.4.1.1248.1.2.2.54.1.3.1.2.2",
            "magenta": "1.3.6.1.4.1.1248.1.2.2.54.1.3.1.2.3",
            "yellow": "1.3.6.1.4.1.1248.1.2.2.54.1.3.1.2.4",
        }
    )
    heartbeat_seconds: int = 30
    snmp_seconds: int = 60
    print_progress_timeout: int = 180  # no page progress → failure (spec §7)


def load_config(path: str | None = None) -> AgentConfig:
    path = path or os.environ.get("KIOSK_CONFIG", "/etc/kiosk/config.yaml")
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}

    required = ("kiosk_id", "kiosk_secret", "api_url", "printer_ip")
    missing = [key for key in required if not raw.get(key)]
    if missing:
        raise SystemExit(f"config missing required keys: {', '.join(missing)} ({path})")

    cfg = AgentConfig(
        kiosk_id=str(raw["kiosk_id"]),
        kiosk_secret=str(raw["kiosk_secret"]),
        api_url=str(raw["api_url"]).rstrip("/"),
        printer_ip=str(raw["printer_ip"]),
        printer_queue_name=str(raw.get("printer_queue_name", "L15150")),
        display_port=int(raw.get("display_port", 8080)),
        tmp_dir=str(raw.get("tmp_dir", "/dev/shm/kiosk")),
        heartbeat_seconds=int(raw.get("heartbeat_seconds", 30)),
        snmp_seconds=int(raw.get("snmp_seconds", 60)),
    )
    if raw.get("snmp_oids"):
        cfg.snmp_oids = {str(k): str(v) for k, v in raw["snmp_oids"].items()}
    return cfg
