"""Which model provider `_build_model` picks.

Strands is model-agnostic by design, and the hackathon's own FAQ is
explicit that eligibility never depended on Bedrock specifically. This
is the regression test for the actual fix: ANTHROPIC_API_KEY set means
Bedrock's IAM/model-access step is no longer what decides whether the
agent runs at all.
"""

from strands.models import BedrockModel
from strands.models.anthropic import AnthropicModel

from src.agent import SYSTEM_PROMPT, _build_model
from src.tools.wallet import check_wallet_balance


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


def test_the_agent_is_told_never_to_answer_a_balance_question_from_memory():
    # Caught live: a stale balance number from earlier in the same chat
    # is a real risk with an agent that carries its own conversation
    # history (Strands keeps it in-process per chat, see
    # telegram_bot.py's own header) -- nothing stops the model reusing a
    # figure it already said instead of calling the tool again. The
    # purchase path itself was never actually at risk (store.debit()
    # checks the real balance regardless of what the model believes),
    # but what it *says* was.
    assert "never" in SYSTEM_PROMPT.lower()
    assert "fresh" in SYSTEM_PROMPT.lower()

    doc = (check_wallet_balance.__doc__ or "").lower()
    assert "even if you already" in doc
    assert "memory" in doc


def test_the_agent_is_told_to_report_only_what_buy_airtime_actually_returned():
    # Caught live: the agent described a declined-and-reversed purchase
    # as "pending", a status the tool never returned. The system prompt
    # now pins the exact fields it's allowed to narrate from.
    prompt = SYSTEM_PROMPT.lower()
    assert "only the fields it actually returned" in prompt
    assert '"pending"' in prompt
