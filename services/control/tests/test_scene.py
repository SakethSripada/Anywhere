from anywhere.scene import SCENE_PROMPT, extract_code


def test_extract_code_drops_fences_and_reasoning():
    reply = "<think>plan</think>Sure:\n```python\nkit.clear()\nkit.city()\n```\nEnjoy"
    assert extract_code(reply) == "kit.clear()\nkit.city()"
    assert extract_code("kit.clear()\nkit.show()") == "kit.clear()\nkit.show()"


def test_prompt_example_ends_with_the_required_finish():
    tail = SCENE_PROMPT.strip().splitlines()[-4:]
    assert tail[-3:] == ["kit.glow()", "kit.show()", "kit.save()"]
