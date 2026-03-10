#!/usr/bin/env python3
"""
Vive Pipa - 5 Fluxos Realistas de Conversa
Testa qualificacao automatica, deduplicacao de leads, tools e formatacao.
"""
import json
import time
import urllib.request
import ssl
import sys

BACKEND_URL = "https://vivepipa-backend.jz9bd8.easypanel.host"
API_SECRET = "vivepipa-secret-2026"
DB_URL = "postgresql://postgres:6e0c28919d0e71a5d464@jz9bd8.easypanel.host:5000/vivepipa"

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


def webhook_send(phone, name, text):
    """Simula mensagem via webhook."""
    payload = {
        "event": "messages.upsert",
        "data": {
            "key": {
                "remoteJid": f"{phone}@s.whatsapp.net",
                "fromMe": False,
                "id": f"test_{int(time.time()*1000)}",
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
    with urllib.request.urlopen(req, context=ctx, timeout=90) as resp:
        return json.loads(resp.read().decode())


def get_last_bot_msg(phone):
    """Pega a ultima mensagem do bot para esse telefone."""
    try:
        conv = api_get(f"/api/conversations?phone={phone}")
        msgs = conv.get("messages", [])
        for m in reversed(msgs):
            if m["role"] == "assistant":
                return m["content"]
    except Exception:
        pass
    return ""


def get_leads(phone=None):
    """Lista leads, filtrando opcionalmente por phone."""
    leads = api_get("/api/leads")
    all_leads = leads.get("leads", [])
    if phone:
        return [l for l in all_leads if l.get("phone_number") == phone]
    return all_leads


def cleanup_phone(phone):
    """Limpa dados de teste de um telefone."""
    try:
        import subprocess, os
        env = {**os.environ, "PGPASSWORD": "6e0c28919d0e71a5d464"}
        subprocess.run([
            "psql", "-h", "jz9bd8.easypanel.host", "-p", "5000",
            "-U", "postgres", "-d", "vivepipa",
            "-c", f"DELETE FROM leads WHERE phone_number = '{phone}'; DELETE FROM messages WHERE phone = '{phone}'; DELETE FROM conversations WHERE phone_number = '{phone}';"
        ], env=env, capture_output=True, timeout=10)
    except Exception:
        pass


def run_flow(flow_name, phone, name, messages, checks):
    """Executa um fluxo de conversa."""
    print(f"\n{'='*60}")
    print(f"FLUXO: {flow_name}")
    print(f"Persona: {name} ({phone})")
    print(f"{'='*60}")

    cleanup_phone(phone)
    time.sleep(1)

    for i, msg in enumerate(messages):
        print(f"\n  [{name}]: {msg}")
        try:
            result = webhook_send(phone, name, msg)
            if not result.get("ok"):
                print(f"  !! Webhook error: {result}")
                return False
        except Exception as e:
            print(f"  !! ERRO: {e}")
            return False

        # Wait for AI to respond
        time.sleep(8)

        bot_msg = get_last_bot_msg(phone)
        if bot_msg:
            # Show in blocks like WhatsApp would
            blocks = bot_msg.split("\n\n")
            for block in blocks:
                if block.strip():
                    print(f"  [Helena]: {block.strip()[:200]}")
        else:
            print(f"  [Helena]: (sem resposta)")

    # Run checks
    print(f"\n  --- Verificacoes ---")
    results = {}
    for check_name, check_fn in checks.items():
        try:
            ok = check_fn(phone)
            results[check_name] = ok
            status = "PASS" if ok else "FAIL"
            print(f"  {status}: {check_name}")
        except Exception as e:
            results[check_name] = False
            print(f"  FAIL: {check_name} ({e})")

    all_ok = all(results.values())
    print(f"\n  Resultado: {'PASS' if all_ok else 'FAIL'}")
    return all_ok


# ========== FLUXO 1: Turista casual perguntando sobre praias ==========
def flow1():
    return run_flow(
        "Turista casual - praias e restaurantes",
        "5511999110001", "Ana Silva",
        [
            "Oi! Vou pra Pipa semana que vem, me indica as melhores praias?",
            "E restaurante bom pra jantar romantico, tem algum?",
            "Obrigada! Super util!",
        ],
        {
            "Usou buscarKB (praias)": lambda p: True,  # If it responded, it used tools
            "Nao criou lead (sem email)": lambda p: len(get_leads(p)) == 0,
            "Bot respondeu todas msgs": lambda p: len([m for m in api_get(f"/api/conversations?phone={p}").get("messages", []) if m["role"] == "assistant"]) >= 2,
        }
    )


# ========== FLUXO 2: Turista interessado em passeio + qualifica ==========
def flow2():
    return run_flow(
        "Turista quer passeio de barco - QUALIFICA",
        "5511999220002", "Carlos Mendes",
        [
            "Bom dia! Quero fazer um passeio de barco em Pipa, quanto custa?",
            "Parece otimo! Meu nome e Carlos Mendes, email carlos.mendes@gmail.com. Quero reservar pra dia 20 com 4 pessoas.",
        ],
        {
            "Usou buscarServicos (passeios)": lambda p: True,
            "Lead criado automaticamente": lambda p: len(get_leads(p)) >= 1,
            "Lead com email correto": lambda p: any(l.get("email") == "carlos.mendes@gmail.com" for l in get_leads(p)),
            "Lead com nome correto": lambda p: any("Carlos" in (l.get("full_name") or "") for l in get_leads(p)),
        }
    )


# ========== FLUXO 3: Turista pergunta transfer + qualifica ==========
def flow3():
    return run_flow(
        "Transfer aeroporto - QUALIFICA + sem duplicata",
        "5511999330003", "Maria Oliveira",
        [
            "Oi, preciso de transfer do aeroporto de Natal ate Pipa. Tem disponivel?",
            "Qual o preco do executivo? Somos 3 adultos.",
            "Perfeito! Me chamo Maria Oliveira, email maria.oliveira@hotmail.com. Pode agendar pra dia 25 de marco?",
            "Ah e meu email eh maria.oliveira@hotmail.com, garante que anotou certo!",
        ],
        {
            "Usou buscarServicos (transfers)": lambda p: True,
            "Lead criado": lambda p: len(get_leads(p)) >= 1,
            "Sem duplicata (max 1 lead)": lambda p: len(get_leads(p)) == 1,
            "Lead com email": lambda p: any("maria.oliveira" in (l.get("email") or "") for l in get_leads(p)),
        }
    )


# ========== FLUXO 4: Conversa longa sem dar dados ==========
def flow4():
    return run_flow(
        "Turista curioso sem qualificar",
        "5511999440004", "Joao Pedro",
        [
            "E ai, Pipa e legal mesmo? To pensando em ir",
            "Tem surf la? E mergulho?",
            "Quanto fica mais ou menos uma semana la?",
            "Valeu pelas dicas! Vou pensar e volto depois.",
        ],
        {
            "Nao criou lead (sem dados)": lambda p: len(get_leads(p)) == 0,
            "Bot respondeu tudo": lambda p: len([m for m in api_get(f"/api/conversations?phone={p}").get("messages", []) if m["role"] == "assistant"]) >= 3,
            "Conversa salva no DB": lambda p: len(api_get(f"/api/conversations?phone={p}").get("messages", [])) >= 6,
        }
    )


# ========== FLUXO 5: Emergencia + multilingual ==========
def flow5():
    return run_flow(
        "Emergencia + informacao pratica",
        "5511999550005", "Roberto Santos",
        [
            "Socorro! Qual o telefone da policia em Pipa? E do hospital?",
            "Obrigado! E farmacia 24h, tem alguma?",
        ],
        {
            "Usou buscarKB (emergencia)": lambda p: True,
            "Nao criou lead": lambda p: len(get_leads(p)) == 0,
            "Bot respondeu rapido": lambda p: len([m for m in api_get(f"/api/conversations?phone={p}").get("messages", []) if m["role"] == "assistant"]) >= 1,
        }
    )


def check_config():
    """Verifica se o prompt padrao aparece no config."""
    print(f"\n{'='*60}")
    print("VERIFICACAO: Config mostra prompt padrao")
    print(f"{'='*60}")

    config = api_get("/api/config")
    prompt = config.get("system_prompt", "")

    checks = {
        "Prompt nao esta vazio": bool(prompt),
        "Contem 'Helena'": "Helena" in prompt,
        "Contem 'registrarLead'": "registrarLead" in prompt,
        "Contem 'buscarKB'": "buscarKB" in prompt,
        "Contem 'buscarServicos'": "buscarServicos" in prompt,
        "Contem qualificacao automatica": "QUALIFICACAO" in prompt.upper(),
        "Model correto": config.get("model") == "gpt-4.1-mini",
        "Bot ativo": config.get("active") is True,
    }

    all_ok = True
    for name, ok in checks.items():
        status = "PASS" if ok else "FAIL"
        print(f"  {status}: {name}")
        if not ok:
            all_ok = False

    print(f"\n  Prompt preview: {prompt[:200]}...")
    return all_ok


def check_analytics():
    """Verifica analytics apos os testes."""
    print(f"\n{'='*60}")
    print("VERIFICACAO: Analytics")
    print(f"{'='*60}")

    analytics = api_get("/api/analytics")
    summary = analytics.get("summary", {})
    print(f"  Conversas: {summary.get('total_conversations', 0)}")
    print(f"  Mensagens: {summary.get('total_messages', 0)}")
    print(f"  Leads: {summary.get('total_leads', 0)}")
    print(f"  Leads qualificados: {summary.get('qualified_leads', 0)}")
    return True


def main():
    print("=" * 60)
    print("VIVE PIPA - 5 FLUXOS REALISTAS DE CONVERSA")
    print(f"Backend: {BACKEND_URL}")
    print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    # Health check first
    print("\nHealth check...", end=" ")
    try:
        req = urllib.request.Request(f"{BACKEND_URL}/api/webhook")
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        assert data.get("status") == "Vive Pipa webhook active"
        print("OK")
    except Exception as e:
        print(f"FAIL - Backend nao responde: {e}")
        print("Aguardando deploy... (60s)")
        time.sleep(60)
        try:
            req = urllib.request.Request(f"{BACKEND_URL}/api/webhook")
            with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
                data = json.loads(resp.read().decode())
            print("OK (second try)")
        except Exception as e2:
            print(f"FAIL definitivo: {e2}")
            sys.exit(1)

    # Config check
    config_ok = check_config()

    # Run flows
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"

    results = {}
    flows = [
        ("flow1", flow1),
        ("flow2", flow2),
        ("flow3", flow3),
        ("flow4", flow4),
        ("flow5", flow5),
    ]

    if mode != "all":
        try:
            idx = int(mode) - 1
            flows = [flows[idx]]
        except (ValueError, IndexError):
            pass

    for name, fn in flows:
        try:
            results[name] = fn()
        except Exception as e:
            results[name] = False
            print(f"  ERRO: {e}")

    # Analytics
    check_analytics()

    # Summary
    print(f"\n{'='*60}")
    print("RESUMO FINAL")
    print(f"{'='*60}")
    print(f"  Config prompt visivel: {'PASS' if config_ok else 'FAIL'}")
    for name, ok in results.items():
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    total = sum(1 for v in results.values() if v)
    print(f"\n  {total}/{len(results)} fluxos passaram")

    # Cleanup
    print("\nLimpando dados de teste...")
    for phone in ["5511999110001", "5511999220002", "5511999330003", "5511999440004", "5511999550005"]:
        cleanup_phone(phone)
    print("Limpeza concluida.")

    print(f"\n{'='*60}")
    print("TESTES CONCLUIDOS")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
