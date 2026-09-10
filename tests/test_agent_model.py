"""Which model provider `_build_model` picks.

Strands is model-agnostic by design, and the hackathon's own FAQ is
explicit that eligibility never depended on Bedrock specifically. This
is the regression test for the actual fix: ANTHROPIC_API_KEY set means
Bedrock's IAM/model-access step is no longer what decides whether the
agent runs at all.
"""

from strands.models import BedrockModel
from strands.models.anthropic import AnthropicModel

from src.agent import _build_model


def test_anthropic_key_set_picks_the_anthropic_provider(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")

    model = _build_model()

    assert isinstance(model, AnthropicModel)
    assert model.config["model_id"]
    assert model.config["max_tokens"] == 1024


def test_anthropic_key_unset_falls_back_to_bedrock(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    model = _build_model()

    assert isinstance(model, BedrockModel)


def test_model_id_is_configurable_via_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")
    monkeypatch.setenv("ANTHROPIC_MODEL_ID", "claude-haiku-4-5-20251001")

    # _ANTHROPIC_MODEL_ID is read at import time, so re-read the env the
    # same way agent.py's own module scope does rather than importing a
    # stale module-level constant.
    import importlib

    import src.agent as agent_module

    importlib.reload(agent_module)
    try:
        model = agent_module._build_model()
        assert model.config["model_id"] == "claude-haiku-4-5-20251001"
    finally:
        importlib.reload(agent_module)
