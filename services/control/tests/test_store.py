"""Store lookups filter on the server and fall back to a scan if a filter is rejected."""

import pytest

from anywhere.stdb import SpacetimeError
from anywhere.store import Store

OWNER = "ab" * 32


class Client:
    def __init__(self, rows: dict[str, list[dict]], reject_where: bool = False):
        self.rows = rows
        self.reject_where = reject_where
        self.queries: list[str] = []

    async def sql(self, query: str) -> list[dict]:
        self.queries.append(query)
        view = query.split("FROM ")[1].split()[0]
        if " WHERE " in query and self.reject_where:
            raise SpacetimeError("unsupported", 400)
        return list(self.rows.get(view, []))


@pytest.mark.parametrize("reject", [False, True])
async def test_lookups_return_the_matching_row(reject):
    client = Client(
        {
            "worker_workloads": [{"id": 1}, {"id": 2}],
            "worker_accounts": [{"identity": OWNER}, {"identity": "cd" * 32}],
            "worker_handles": [{"handle": "+15550001", "owner": OWNER}, {"handle": "o'brien", "owner": "cd" * 32}],
        },
        reject_where=reject,
    )
    store = Store(client)
    assert (await store.workload(2))["id"] == 2
    assert (await store.account(OWNER))["identity"] == OWNER
    assert await store.handle_owner("o'brien") == "cd" * 32
    assert await store.handles_for(OWNER) == ["+15550001"]


async def test_filters_are_pushed_into_sql_and_escaped():
    client = Client({})
    store = Store(client)
    await store.workload(7)
    await store.account(OWNER)
    await store.handle_owner("o'brien")
    assert client.queries == [
        "SELECT * FROM worker_workloads WHERE id = 7",
        f"SELECT * FROM worker_accounts WHERE identity = 0x{OWNER}",
        "SELECT * FROM worker_handles WHERE handle = 'o''brien'",
    ]


async def test_malformed_identities_never_reach_sql():
    client = Client({})
    store = Store(client)
    assert await store.account("1 OR 1=1") is None
    assert await store.handles_for("x") == []
    assert client.queries == []


@pytest.mark.parametrize("reject", [False, True])
async def test_workloads_for_filters_by_owner_on_the_server(reject):
    client = Client({"worker_workloads": [{"id": 1, "owner": OWNER}, {"id": 2, "owner": "cd" * 32}]}, reject)
    rows = await Store(client).workloads_for(OWNER)
    assert [w["id"] for w in rows] == [1]
    assert client.queries[0] == f"SELECT * FROM worker_workloads WHERE owner = 0x{OWNER}"


async def test_step_summaries_skip_detail_and_fall_back_to_a_full_read():
    class Projecting(Client):
        async def sql(self, query):
            self.queries.append(query)
            if query.startswith("SELECT seq"):
                raise SpacetimeError("unsupported", 400)
            return [{"seq": 2, "detail": "x"}, {"seq": 1, "detail": "y"}]

    client = Projecting({})
    rows = await Store(client).agent_step_summaries(5)
    assert [r["seq"] for r in rows] == [1, 2]
    assert client.queries[0].startswith("SELECT seq, kind, summary, screenshotKey FROM worker_agent_steps")
