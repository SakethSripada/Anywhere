import pytest

from anywhere.brev import BrevCLI, Instance
from anywhere.config import ProvisioningMode
from anywhere.supervisor import boot_stage


def inst(status: str, shell: str = "") -> Instance:
    return Instance(name="n", id="i", status=status, shell_status=shell, health_status="", instance_type="t")


@pytest.mark.asyncio
async def test_wait_for_reports_each_new_stage_once(monkeypatch):
    stages = iter(
        [inst("DEPLOYING"), inst("DEPLOYING"), inst("STARTING"), inst("RUNNING", "NOT READY"), inst("RUNNING", "READY")]
    )
    cli = BrevCLI("brev", "bak-test", ProvisioningMode.LIVE)

    async def get(name):
        return next(stages)

    monkeypatch.setattr(cli, "get", get)
    heard: list[str] = []

    async def on_change(i: Instance):
        heard.append(f"{i.status}/{i.shell_status}")

    got = await cli.wait_for("n", interval=0, on_change=on_change)
    assert got.ready
    assert heard == ["DEPLOYING/", "STARTING/", "RUNNING/NOT READY", "RUNNING/READY"]


@pytest.mark.asyncio
async def test_a_failing_progress_callback_does_not_break_the_wait(monkeypatch):
    cli = BrevCLI("brev", "bak-test", ProvisioningMode.LIVE)

    async def get(name):
        return inst("RUNNING", "READY")

    async def boom(i):
        raise RuntimeError("store down")

    monkeypatch.setattr(cli, "get", get)
    assert (await cli.wait_for("n", interval=0, on_change=boom)).ready


def test_boot_stage_words():
    assert boot_stage(inst("DEPLOYING")) == "Brev is allocating the GPU"
    assert boot_stage(inst("RUNNING", "NOT READY")) == "Machine is up, waiting for its shell"
    assert boot_stage(inst("RUNNING", "READY")) == "Machine is up"
    assert boot_stage(inst("WEIRD")) is None


@pytest.mark.asyncio
async def test_wait_for_fails_fast_when_brev_deletes_the_instance(monkeypatch):
    from anywhere.brev import BrevError

    stages = iter([inst("DEPLOYING"), inst("DELETING", "NOT READY")])
    cli = BrevCLI("brev", "bak-test", ProvisioningMode.LIVE)

    async def get(name):
        return next(stages)

    monkeypatch.setattr(cli, "get", get)
    with pytest.raises(BrevError, match="shut the machine down"):
        await cli.wait_for("n", interval=0)


@pytest.mark.asyncio
async def test_wait_for_fails_fast_when_the_instance_vanishes(monkeypatch):
    from anywhere.brev import BrevError

    stages = iter([None, inst("DEPLOYING"), None])
    cli = BrevCLI("brev", "bak-test", ProvisioningMode.LIVE)

    async def get(name):
        return next(stages)

    monkeypatch.setattr(cli, "get", get)
    with pytest.raises(BrevError, match="disappeared"):
        await cli.wait_for("n", interval=0)
