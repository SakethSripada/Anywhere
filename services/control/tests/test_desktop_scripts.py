"""Run the desktop shell scripts against fake `docker`, `nvidia-smi`, `sudo` and
`curl` binaries, so their control flow is checked without a VM."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from anywhere.supervisor import _env, render

FAKE_DOCKER = r"""#!/usr/bin/env bash
# Records every call; behaviour is steered by files in $FAKE.
echo "docker $*" >> "$FAKE/calls"
case "$1" in
  info|ps)
    n=$(cat "$FAKE/info_fails" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE/info_fails"; exit 1; fi
    exit 0 ;;
  container) exit 1 ;;  # `container inspect`: no desktop container yet
  run) echo abc123 ;;
  exec)
    case "$*" in
      *"stat -c %U"*) echo cua ;;
      *"/dev/tcp/127.0.0.1/5900"*) [ -f "$FAKE/vnc_down" ] || printf 'RFB' ;;
    esac ;;
esac
exit 0
"""


def _fakes(tmp_path: Path) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    scripts = {
        "docker": FAKE_DOCKER,
        "nvidia-smi": "#!/usr/bin/env bash\necho 'Tesla T4, 15360 MiB, 535.0'\n",
        # Run the command without elevation; the fake docker doesn't care.
        "sudo": '#!/usr/bin/env bash\n[ "$1" = -n ] && shift\nexec "$@"\n',
        "curl": '#!/usr/bin/env bash\n[ -f "$FAKE/http_down" ] && exit 7\nexit 0\n',
        "sleep": "#!/usr/bin/env bash\nexit 0\n",
    }
    for name, body in scripts.items():
        p = bin_dir / name
        p.write_text(body)
        p.chmod(0o755)
    (tmp_path / "home").mkdir()
    return {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "FAKE": str(tmp_path),
        "HOME": str(tmp_path / "home"),
    }


def _run(script: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "-s"], input=script, env=env, capture_output=True, text=True, timeout=60)


def _setup_script() -> str:
    return render(
        _env("desktop-setup.sh"), DESKTOP_IMAGE="img", BLENDER_VERSION="4.5.15", BLENDER_SHA256="x", CUA_TOKEN="t"
    )


def test_desktop_setup_publishes_both_vnc_bridges_on_loopback(tmp_path):
    env = _fakes(tmp_path)
    result = _run(_setup_script(), env)
    assert result.returncode == 0, result.stdout + result.stderr
    run = next(c for c in (tmp_path / "calls").read_text().splitlines() if c.startswith("docker run"))
    # desktop-start.sh serves the watch-link stream on 6081; unpublished, it can't be tunneled to.
    for port in (3211, 6080, 6081):
        assert f"-p 127.0.0.1:{port}:{port}" in run


def test_desktop_setup_waits_for_docker_on_first_boot(tmp_path):
    env = _fakes(tmp_path)
    (tmp_path / "info_fails").write_text("6")  # the daemon answers on the fourth look (two probes each)
    result = _run(_setup_script(), env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "::step:: Desktop environment installed" in result.stdout


def test_desktop_setup_names_a_missing_gpu(tmp_path):
    env = _fakes(tmp_path)
    (tmp_path / "bin" / "nvidia-smi").write_text("#!/usr/bin/env bash\nexit 9\n")
    result = _run(_setup_script(), env)
    assert result.returncode == 1
    assert "::error:: No NVIDIA GPU is visible on this machine" in result.stdout


def test_desktop_start_waits_for_docker_after_a_resume(tmp_path):
    env = _fakes(tmp_path)
    (tmp_path / "info_fails").write_text("4")
    result = _run(_env("desktop-start.sh"), env)
    assert result.returncode == 0, result.stderr
    assert "::ready::" in result.stdout
    assert "docker start anywhere-desktop" in (tmp_path / "calls").read_text()


def test_desktop_start_is_not_ready_until_vnc_answers(tmp_path):
    env = _fakes(tmp_path)
    (tmp_path / "vnc_down").touch()  # websockify and Cua answer, x11vnc doesn't
    result = _run(_env("desktop-start.sh"), env)
    assert result.returncode == 1
    assert "::ready::" not in result.stdout
    # The control plane shows stderr; it must say what failed in plain words.
    assert result.stderr.strip() == "The desktop's VNC and Cua services did not come up"
    # It kept relaunching the (idempotent) VNC services while it waited.
    launches = (tmp_path / "calls").read_text().count("-rfbport 5900")
    assert launches > 1


def test_remote_errors_lead_with_the_scripts_last_line():
    from anywhere.remote import describe_exit

    msg = describe_exit(1, "Xvfb: GLX failed\nmore noise\nThe desktop's display did not start\n")
    assert msg.splitlines()[0] == "The desktop's display did not start"
    assert "Xvfb: GLX failed" in msg
    assert describe_exit(255, "") == "Remote command exited 255"
