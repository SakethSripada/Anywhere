"""Runtime configuration. Every external integration is optional at boot so the
service can start (and report what is missing) before keys are provisioned."""

from enum import StrEnum
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProvisioningMode(StrEnum):
    #: Plans are produced and validated, but nothing is sent to Brev.
    DISABLED = "disabled"
    #: Plans are validated against Brev with `brev create --dry-run`; nothing is billed.
    DRY_RUN = "dry_run"
    #: Real instances are created. Requires explicit opt-in.
    LIVE = "live"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    # Service
    environment: str = "development"
    public_web_origin: str = "http://localhost:3001"
    data_dir: Path = Path(".data")
    log_level: str = "INFO"

    # Access gate: new identities must redeem this code before they can plan compute.
    invite_code: SecretStr | None = None

    # SpacetimeDB
    spacetime_host: str = "http://127.0.0.1:3000"
    spacetime_database: str = "anywhere"
    #: Token for this service's worker identity (mint with `anywhere identity`; see README).
    spacetime_worker_token: SecretStr | None = None

    # NVIDIA Nemotron (build.nvidia.com)
    nvidia_api_key: SecretStr | None = None
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    #: Central agent: Nemotron 3 Super (tool calling + reasoning). Both ids are in
    #: the integrate.api.nvidia.com catalog and in langchain-nvidia-ai-endpoints'
    #: model table with tool support.
    planner_model: str = "nvidia/nemotron-3-super-120b-a12b"
    #: Desktop operator: Nemotron 3.5 Super VL reads screenshots (image input + tools).
    vision_model: str = "nvidia/nemotron-3.5-super-vl-120b-a12b"
    #: Reasoning before each GUI action is slower; off by default for the operator loop.
    vision_thinking: bool = False

    # NVIDIA Brev
    brev_api_key: SecretStr | None = None
    brev_binary: str = "brev"
    provisioning_mode: ProvisioningMode = ProvisioningMode.DISABLED

    # Spending guardrails (whole platform). Defaults leave headroom under $60 of credit.
    global_budget_cents: int = 5000
    max_concurrent_instances: int = 1
    max_session_hours: float = 4.0
    desktop_idle_minutes: int = 20
    budget_tick_seconds: int = 30

    # Object storage (any S3-compatible API: Cloudflare R2, AWS S3, MinIO)
    s3_endpoint_url: str | None = None
    s3_region: str = "auto"
    s3_bucket: str | None = None
    s3_access_key_id: SecretStr | None = None
    s3_secret_access_key: SecretStr | None = None
    max_upload_bytes: int = 2 * 1024**3

    # Photon (Spectrum) messaging
    spectrum_project_id: str | None = None
    spectrum_project_secret: SecretStr | None = None
    spectrum_api_base: str = "https://spectrum.photon.codes"
    #: Shared secret the messaging bridge uses to call this service.
    messaging_bridge_secret: SecretStr | None = None

    # Desktop environment
    desktop_image: str = "ghcr.io/trycua/linux:24.04"
    blender_version: str = "4.5.15"

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3001"])

    @property
    def stdb_ready(self) -> bool:
        return self.spacetime_worker_token is not None

    @property
    def nemotron_ready(self) -> bool:
        return self.nvidia_api_key is not None

    @property
    def brev_ready(self) -> bool:
        return self.brev_api_key is not None

    @property
    def storage_ready(self) -> bool:
        return all([self.s3_bucket, self.s3_access_key_id, self.s3_secret_access_key])

    @property
    def photon_ready(self) -> bool:
        return self.spectrum_project_id is not None and self.spectrum_project_secret is not None

    def integrations(self) -> dict[str, bool]:
        return {
            "spacetime": self.stdb_ready,
            "nemotron": self.nemotron_ready,
            "brev": self.brev_ready,
            "storage": self.storage_ready,
            "photon": self.photon_ready,
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
