"""Contract tests for SOTAgent schemas (260505 batch)."""

import json
from pathlib import Path

import pytest

CONTRACTS = Path(__file__).resolve().parent.parent.parent / "contracts"
EXAMPLES = CONTRACTS / "examples"


def _load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def _validate_required(schema: dict, instance: dict) -> list[str]:
    errors = []
    for field in schema.get("required", []):
        if field not in instance:
            errors.append(f"missing required: {field}")
    for field, value in instance.items():
        prop = schema.get("properties", {}).get(field, {})
        if "enum" in prop and value not in prop["enum"]:
            errors.append(f"{field}: {value!r} not in {prop['enum']}")
    return errors


class TestInboxOutboxSchema:
    schema = _load(CONTRACTS / "inbox-outbox.schema.json")

    def test_example_passes(self):
        example = _load(EXAMPLES / "inbox-message.example.json")
        assert _validate_required(self.schema, example) == []

    def test_missing_source_rejected(self):
        bad = {"id": "x", "target": "y", "type": "event", "payload": {}, "timestamp": "2026-01-01T00:00:00Z"}
        errors = _validate_required(self.schema, bad)
        assert any("source" in e for e in errors)


class TestPeerSyncSchema:
    schema = _load(CONTRACTS / "peer-sync.schema.json")

    def test_valid_heartbeat(self):
        msg = {"type": "heartbeat", "peer_id": "mac-studio", "timestamp": "2026-01-01T00:00:00Z"}
        assert _validate_required(self.schema, msg) == []

    def test_invalid_type_rejected(self):
        msg = {"type": "invalid_type"}
        errors = _validate_required(self.schema, msg)
        assert any("type" in e for e in errors)


class TestHttpApiSchema:
    schema = _load(CONTRACTS / "http-api.schema.json")

    def test_schema_loads(self):
        assert self.schema["title"] == "SOTAgent HTTP API"
