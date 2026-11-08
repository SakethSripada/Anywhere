"""POST /v1/workloads/plan: the template launcher's no-LLM planning path."""

import json

import pytest
from fastapi.testclient import TestClient

from anywhere.api import create_app
from anywhere.auth import current_identity
from anywhere.config import Settings
from anywhere.core import Anywhere
from anywhere.storage import Storage
from anywhere.vault import Vault

from .fakes import FakeBrev, FakeStore

OWNER = "ab" * 32


def account(**over):
    return {
        "identity": OWNER,
        "activated": True,
        "monthlyCapCents": 2000,
        "approvalThresholdCents": 0,
        "preference": "balanced",
        **over,
    }


@pytest.fixture
def env(tmp_path):
    settings = Settings(_env_file=None, data_dir=tmp_path)
    store = FakeStore()
    store.accounts_.append(account())
    app = Anywhere(
        settings=settings,
        store=store,
        public_stdb=None,
        brev=FakeBrev(),
        storage=Storage(settings),
        vault=Vault(tmp_path / "vault.json"),
    )
    api = create_app(settings)
    api.dependency_overrides[current_identity] = lambda: OWNER
    with TestClient(api) as client:
        api.state.anywhere = app
        yield client, store, app


def test_desktop_plan_creates_conversation_messages_and_workload(env):
    client, store, _ = env
    res = client.post("/v1/workloads/plan", json={"kind": "desktop", "application": "blender", "session_hours": 2})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True and body["workload_id"]
    cid = body["conversation_id"]
    assert store.conversations[cid]["owner"] == OWNER
    w = store.rows[body["workload_id"]]
    assert w["status"] == "planned" and w["kind"] == "desktop" and w["conversationId"] == cid
    kinds = [(role, kind) for (c, role, kind, _, _) in store.messages if c == cid]
    assert kinds == [("user", "text"), ("assistant", "plan"), ("assistant", "text")]
    assert "Blender" in store.messages[0][3] and "2 hours" in store.messages[0][3]
    assert "Approve" in body["message"] and body["message"] == store.messages[-1][3]


def test_preference_override_reaches_the_planner(env):
    client, store, _ = env
    cheap = client.post(
        "/v1/workloads/plan", json={"kind": "desktop", "application": "blender", "preference": "cheapest"}
    )
    fast = client.post(
        "/v1/workloads/plan", json={"kind": "desktop", "application": "blender", "preference": "fastest"}
    )
    a, b = store.rows[cheap.json()["workload_id"]], store.rows[fast.json()["workload_id"]]
    assert a["hourlyCents"] <= b["hourlyCents"]
    assert json.loads(a["planJson"])["intent"]["preference"] == "cheapest"


def test_refusals_are_recorded_and_returned(env):
    client, store, _ = env
    res = client.post("/v1/workloads/plan", json={"kind": "desktop", "application": "unity"}).json()
    assert res["ok"] is False and res["workload_id"] is None
    assert "Unity" in res["message"]
    assert store.messages[-1][1:3] == ("assistant", "text") and store.messages[-1][3] == res["message"]

    ft = client.post("/v1/workloads/plan", json={"kind": "fine_tune", "model_params_billions": 7}).json()
    assert ft["ok"] is False and "dataset" in ft["message"]


def test_budget_policy_applies(env):
    client, store, _ = env
    store.accounts_[0]["activated"] = False
    res = client.post("/v1/workloads/plan", json={"kind": "desktop", "application": "vscode"}).json()
    assert res["ok"] is True
    assert "can't start yet" in res["message"]


def test_existing_conversation_must_belong_to_caller(env):
    client, store, _ = env
    store.conversations[5] = {"id": 5, "owner": "cd" * 32}
    res = client.post("/v1/workloads/plan", json={"kind": "desktop", "conversation_id": 5})
    assert res.status_code == 409
    store.conversations[6] = {"id": 6, "owner": OWNER}
    ok = client.post("/v1/workloads/plan", json={"kind": "desktop", "conversation_id": 6}).json()
    assert ok["conversation_id"] == 6 and ok["ok"]


def test_validation_and_auth(env, tmp_path):
    client, _, _ = env
    assert client.post("/v1/workloads/plan", json={"kind": "render"}).status_code == 422
    assert client.post("/v1/workloads/plan", json={"kind": "fine_tune", "epochs": 50}).status_code == 422
    with TestClient(create_app(Settings(_env_file=None, data_dir=tmp_path / "x"))) as anon:
        assert anon.post("/v1/workloads/plan", json={"kind": "desktop"}).status_code == 401
