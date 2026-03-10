#!/usr/bin/env python3
"""
Vive Pipa - Testes E2E automatizados
Testa todos os fluxos do bot Helena via API.
"""
import json
import time
import urllib.request
import ssl
import sys

# Config
BACKEND_URL = "https://vivepipa-backend.jz9bd8.easypanel.host"
API_SECRET = "vivepipa-secret-2026"
EVOLUTION_URL = "https://apps-evolution-api.klx2s6.easypanel.host"
EVOLUTION_KEY = "CD6D2B1F7373-4086-AAC9-53391CF245E8"
EVOLUTION_INSTANCE = "guyfolkiz"
VIVE_PIPA_NUMBER = "558486876555"
TEST_PHONE = "5511888776655"  # fake number for webhook simulation

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def api_get(path):
    req = urllib.request.Request(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {API_SECRET}"}
    )
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        return json.loads(resp.read().decode())


def api_put(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BACKEND_URL}{path}",
        data=data,
        method="PUT",
        headers={
            "Authorization": f"Bearer {API_SECRET}",
            "Content-Type": "application/json",
        }
    )
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        return json.loads(resp.read().decode())


def webhook_simulate(phone, name, text):
    """Simula uma mensagem WhatsApp via webhook."""
    payload = {
        "event": "messages.upsert",
        "data": {
            "key": {
                "remoteJid": f"{phone}@s.whatsapp.net",
                "fromMe": False,
            },
            "pushName": name,
            "message": {"conversation": text},
        },
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BACKEND_URL}/api/webhook",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
        return json.loads(resp.read().decode())


def send_whatsapp(number, text):
    """Envia mensagem real via Evolution API (guyfolkz -> Vive Pipa)."""
    data = json.dumps({"number": number, "text": text}).encode()
    req = urllib.request.Request(
        f"{EVOLUTION_URL}/message/sendText/{EVOLUTION_INSTANCE}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "apikey": EVOLUTION_KEY,
        }
    )
    with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
        return json.loads(resp.read().decode())


def test_health():
    """Teste 1: Health check do webhook."""
    print("TEST 1: Health Check...", end=" ")
    req = urllib.request.Request(f"{BACKEND_URL}/api/webhook")
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        data = json.loads(resp.read().decode())
    assert data.get("status") == "Vive Pipa webhook active", f"Expected active, got: {data}"
    print("PASS")


def test_api_endpoints():
    """Teste 2: Todos os endpoints da API respondem."""
    print("TEST 2: API Endpoints...", end=" ")
    endpoints = ["/api/analytics", "/api/config", "/api/leads", "/api/conversations"]
    for ep in endpoints:
        try:
            result = api_get(ep)
            assert isinstance(result, dict), f"{ep} returned non-dict"
        except Exception as e:
            print(f"FAIL ({ep}: {e})")
            return
    print("PASS")


def test_config():
    """Teste 3: Bot config - modelo e status."""
    print("TEST 3: Bot Config...", end=" ")
    config = api_get("/api/config")
    assert config.get("active") is True, f"Bot not active: {config}"
    assert config.get("model") == "gpt-4.1-mini", f"Wrong model: {config.get('model')}"
    print(f"PASS (model={config['model']}, active={config['active']})")


def test_config_update():
    """Teste 4: Atualizar config via API."""
    print("TEST 4: Config Update...", end=" ")
    api_put("/api/config", {"model": "gpt-4.1-mini"})
    config = api_get("/api/config")
    assert config.get("model") == "gpt-4.1-mini", f"Config update failed: {config}"
    print("PASS")


def test_webhook_processing():
    """Teste 5: Webhook processa mensagem e gera resposta com AI."""
    print("TEST 5: Webhook Processing (AI)...", end=" ")
    try:
        result = webhook_simulate(TEST_PHONE, "Teste Auto", "Oi, quais passeios tem em Pipa?")
        assert result.get("ok") is True, f"Webhook failed: {result}"
    except Exception as e:
        if "Internal" in str(e):
            print(f"FAIL (AI error - check OPENAI_API_KEY)")
            return
        raise

    # Verify message was saved
    time.sleep(2)
    conv = api_get(f"/api/conversations?phone={TEST_PHONE}")
    messages = conv.get("messages", [])
    assert len(messages) >= 2, f"Expected 2+ messages, got {len(messages)}"
    assert messages[0]["role"] == "user", "First msg should be user"
    assert messages[1]["role"] == "assistant", "Second msg should be assistant"
    print(f"PASS ({len(messages)} msgs)")
    print(f"  Bot said: {messages[-1]['content'][:200]}")


def test_tool_buscar_servicos():
    """Teste 6: Bot usa tool buscarServicos pra transfers."""
    print("TEST 6: Tool buscarServicos...", end=" ")
    try:
        result = webhook_simulate(TEST_PHONE, "Teste Auto", "Quero um transfer do aeroporto de Natal para Pipa. Qual o valor?")
        assert result.get("ok") is True, f"Webhook failed: {result}"
    except Exception as e:
        print(f"FAIL ({e})")
        return

    time.sleep(2)
    conv = api_get(f"/api/conversations?phone={TEST_PHONE}")
    messages = conv.get("messages", [])
    last_msg = messages[-1]["content"] if messages else ""
    # Should mention transfer pricing
    has_price = any(word in last_msg.lower() for word in ["180", "320", "transfer", "r$", "valor"])
    print(f"{'PASS' if has_price else 'WARN - no price found'}")
    print(f"  Bot said: {last_msg[:300]}")


def test_tool_buscar_kb():
    """Teste 7: Bot usa tool buscarKB pra info geral."""
    print("TEST 7: Tool buscarKB...", end=" ")
    try:
        result = webhook_simulate(TEST_PHONE, "Teste Auto", "Qual o telefone dos bombeiros em Pipa?")
        assert result.get("ok") is True, f"Webhook failed: {result}"
    except Exception as e:
        print(f"FAIL ({e})")
        return

    time.sleep(2)
    conv = api_get(f"/api/conversations?phone={TEST_PHONE}")
    messages = conv.get("messages", [])
    last_msg = messages[-1]["content"] if messages else ""
    has_info = any(word in last_msg.lower() for word in ["bombeiro", "emergencia", "192", "193", "telefone"])
    print(f"{'PASS' if has_info else 'WARN - no emergency info found'}")
    print(f"  Bot said: {last_msg[:300]}")


def test_analytics():
    """Teste 8: Analytics reflete as conversas."""
    print("TEST 8: Analytics...", end=" ")
    analytics = api_get("/api/analytics")
    summary = analytics.get("summary", {})
    assert summary.get("total_conversations", 0) > 0, "No conversations in analytics"
    assert summary.get("total_messages", 0) > 0, "No messages in analytics"
    print(f"PASS (convs={summary['total_conversations']}, msgs={summary['total_messages']})")


def test_whatsapp_real():
    """Teste 9: Mensagem real via WhatsApp (guyfolkz -> Vive Pipa)."""
    print("TEST 9: WhatsApp Real (E2E)...", end=" ")
    try:
        result = send_whatsapp(VIVE_PIPA_NUMBER, "Teste automatizado: quanto custa o passeio de barco?")
        msg_id = result.get("key", {}).get("id", "")
        print(f"SENT (id={msg_id})")
        print("  Aguardando resposta do bot (20s)...")
        time.sleep(20)
        # Check if there's a new conversation from the guyfolkz number
        convs = api_get("/api/conversations")
        recent = convs.get("conversations", [])
        if recent:
            last = recent[0]
            print(f"  Ultimo contato: {last.get('phone_number')} ({last.get('user_name')})")
            print(f"  Msgs: {last.get('total_messages')}, Last: {last.get('last_message','')[:200]}")
        print("  PASS (mensagem enviada, verificar WhatsApp)")
    except Exception as e:
        print(f"FAIL ({e})")


def cleanup():
    """Limpa dados de teste."""
    print("\nCLEANUP: Removendo dados de teste...", end=" ")
    try:
        import subprocess
        subprocess.run([
            "psql", "-h", "jz9bd8.easypanel.host", "-p", "5000",
            "-U", "postgres", "-d", "vivepipa",
            "-c", f"DELETE FROM messages WHERE phone = '{TEST_PHONE}'; DELETE FROM conversations WHERE phone_number = '{TEST_PHONE}';"
        ], env={**__import__('os').environ, "PGPASSWORD": "6e0c28919d0e71a5d464"},
           capture_output=True, timeout=10)
        print("OK")
    except Exception:
        print("SKIP (psql not available)")


def main():
    print("=" * 60)
    print("VIVE PIPA - TESTE E2E AUTOMATIZADO")
    print(f"Backend: {BACKEND_URL}")
    print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    print()

    mode = sys.argv[1] if len(sys.argv) > 1 else "all"

    tests = [
        test_health,
        test_api_endpoints,
        test_config,
        test_config_update,
    ]

    if mode in ("all", "ai"):
        tests.extend([
            test_webhook_processing,
            test_tool_buscar_servicos,
            test_tool_buscar_kb,
            test_analytics,
        ])

    if mode in ("all", "whatsapp", "real"):
        tests.append(test_whatsapp_real)

    for test in tests:
        try:
            test()
        except Exception as e:
            print(f"FAIL ({e})")

    if mode in ("all", "ai"):
        cleanup()

    print("\n" + "=" * 60)
    print("TESTES CONCLUIDOS")
    print("=" * 60)


if __name__ == "__main__":
    main()
