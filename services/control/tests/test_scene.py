from anywhere.scene import SCENE_PROMPT, extract_code


def test_extract_code_drops_fences_and_reasoning():
    reply = "<think>plan</think>Sure:\n```python\nkit.clear()\nkit.city()\n```\nEnjoy"
    assert extract_code(reply) == "kit.clear()\nkit.city()"
    assert extract_code("kit.clear()\nkit.show()") == "kit.clear()\nkit.show()"


def test_prompt_example_ends_with_the_required_finish():
    tail = SCENE_PROMPT.strip().splitlines()[-4:]
    assert tail[-3:] == ["kit.glow()", "kit.show()", "kit.save()"]


async def test_scene_scripts_keep_off_a_blender_the_user_or_agent_is_using():
    from types import SimpleNamespace

    from anywhere.scene import blender_in_use, build, quick_render

    running = set()
    messages = []

    class Store:
        async def workload(self, id):
            return {"id": id, "owner": "o", "controller": "user"}

        async def append_message(self, cid, role, kind, body, wid, channel):
            messages.append((kind, body))

    app = SimpleNamespace(supervisor=SimpleNamespace(agent_running=lambda wid: wid in running), store=Store())
    assert "hand back" in blender_in_use(app, {"id": 1, "controller": "user"})
    assert blender_in_use(app, {"id": 1, "controller": "agent"}) == ""
    running.add(1)
    assert "agent is working" in blender_in_use(app, {"id": 1, "controller": "agent"})
    # No connection is made at all: these return before touching the desktop.
    assert await quick_render(app, {"id": 1, "controller": "agent"}) is None
    await build(app, {"id": 2, "owner": "o", "controller": "agent", "conversationId": 5}, "a castle")
    assert messages and messages[0][0] == "error" and "hand back" in messages[0][1]


def test_a_build_moves_to_a_new_file_before_its_script_clears_the_scene():
    from anywhere.scene import _NEW_FILE

    script = _NEW_FILE.format(stamp="20261109-120000")
    compile(script, "new-file", "exec")
    assert "stamp = '20261109-120000'" in script
    assert script.index("save_mainfile()") < script.index(
        'save_as_mainfile(filepath=os.path.expanduser(f"~/Projects/scene-'
    )
