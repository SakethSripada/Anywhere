"""Demo-only scripted 'agent': drives the desktop with xdotool so the browser
stream shows real activity. GET /run?script=blender starts a sequence;
GET /status returns the steps completed so far."""
import json, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

state = {"run": 0, "script": None, "steps": [], "done": True}
lock = threading.Lock()

def x(*args):
    subprocess.run(["xdotool", *args], check=False)

def step(summary, *actions, wait=1.2):
    for a in actions:
        a()
    with lock:
        state["steps"].append(summary)
    time.sleep(wait)

def window_ready(name, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        r = subprocess.run(["xdotool", "search", "--name", name], capture_output=True, text=True)
        if r.stdout.strip():
            return r.stdout.split()[0]
        time.sleep(1)
    return None

def blender():
    subprocess.run(["pkill", "-f", "blender"], check=False)
    time.sleep(1)
    step("Looked at the screen", wait=1)
    subprocess.Popen(["blender", "--window-geometry", "0", "0", "1600", "900"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    step("Opened Blender from the applications menu", wait=2)
    win = window_ready("Blender")
    if win:
        x("windowactivate", win)
        x("key", "super+Up")
    time.sleep(6)
    x("mousemove", "800", "420")
    x("click", "1")
    step("Dismissed the splash screen", wait=1.5)
    step("Selected the default cube", lambda: x("mousemove", "800", "450"), lambda: x("click", "1"))
    step("Deleted the default cube", lambda: x("key", "x"), lambda: (time.sleep(0.5), x("key", "Return")))
    def add(name):
        x("key", "F3"); time.sleep(0.8); x("type", "--delay", "60", name); time.sleep(0.8); x("key", "Return")
    step("Added a cone for the tree crown", lambda: add("cone"), wait=1.5)
    step("Scaled the crown up", lambda: x("key", "s"), lambda: x("type", "1.6"), lambda: x("key", "Return"))
    step("Moved the crown up", lambda: x("key", "g"), lambda: x("key", "z"), lambda: x("type", "1.5"), lambda: x("key", "Return"))
    step("Added a cylinder for the trunk", lambda: add("cylinder"), wait=1.5)
    step("Made the trunk thinner", lambda: x("key", "s"), lambda: x("key", "shift+z"), lambda: x("type", "0.35"), lambda: x("key", "Return"))
    def orbit():
        x("mousemove", "800", "450"); x("mousedown", "2")
        for i in range(30):
            x("mousemove_relative", "--", "8", "0"); time.sleep(0.03)
        x("mouseup", "2")
    step("Orbited the view to check the shape", orbit, wait=1.5)
    step("Saved the project to ~/Projects/tree.blend", lambda: x("key", "ctrl+s"), lambda: (time.sleep(1), x("type", "tree"), x("key", "Return")), wait=1.5)

def terminal():
    subprocess.Popen(["xfce4-terminal", "--geometry", "110x30"])
    step("Opened a terminal", wait=2.5)
    for cmd, s in [("uname -a", "Checked the system"), ("python3 -c \"import platform; print(platform.machine())\"", "Ran a Python check"), ("ls -la ~", "Listed the home folder")]:
        step(s, lambda c=cmd: x("type", "--delay", "35", c), lambda: x("key", "Return"), wait=1.5)

SCRIPTS = {"blender": blender, "terminal": terminal}

def run(name):
    with lock:
        state.update(run=state["run"] + 1, script=name, steps=[], done=False)
    try:
        SCRIPTS[name]()
    finally:
        with lock:
            state["done"] = True

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/run":
            name = parse_qs(u.query).get("script", ["blender"])[0]
            with lock:
                busy = not state["done"]
            if not busy and name in SCRIPTS:
                threading.Thread(target=run, args=(name,), daemon=True).start()
            time.sleep(0.05)
        with lock:
            self._json(dict(state))

ThreadingHTTPServer(("0.0.0.0", 6090), H).serve_forever()
