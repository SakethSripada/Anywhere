from anywhere.config import Settings


def test_trailing_slashes_are_trimmed(monkeypatch):
    monkeypatch.setenv("PUBLIC_WEB_ORIGIN", "http://localhost:3001/")
    monkeypatch.setenv("PUBLIC_API_URL", "http://localhost:8010/")
    monkeypatch.setenv("SPACETIME_HOST", "http://127.0.0.1:3100/")
    monkeypatch.setenv("CORS_ORIGINS", '["https://a.example/"]')
    s = Settings(_env_file=None)
    assert s.public_web_origin == "http://localhost:3001"
    assert s.public_api_url == "http://localhost:8010"
    assert s.spacetime_host == "http://127.0.0.1:3100"
    assert s.cors_origins == ["https://a.example"]
