"""Command-line entry point for AegisAgent."""

from rich.console import Console
from rich.panel import Panel

from aegis_agent.config import SETTINGS
from aegis_agent.graph import AgentState, build_graph

console = Console()
CONFIG = {"configurable": {"thread_id": "cli-session"}}


def main() -> None:
    graph = build_graph()

    mode = "MOCK (offline simulation)" if SETTINGS.mock_mode else "LIVE (on-chain)"
    console.print(
        Panel.fit(
            f"AegisAgent online — {mode}\nType a request, or 'exit' to quit",
            title="0xChainAegis",
        )
    )

    while True:
        try:
            user_input = console.input("[bold cyan]you>[/] ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit"}:
            break

        state = _invoke(graph, {"user_input": user_input})

        if state.get("blocked"):
            console.print(f"[red]guard>[/] {state['block_reason']}")
            continue

        result = state.get("result")
        if result:
            console.print(f"[green]agent>[/] {result}")

        attestation = state.get("attestation")
        if attestation:
            from aegis_agent.tools.attestation import verify_record

            record = attestation["record"]
            record_hash = attestation["hash"]
            ok = verify_record(record, record_hash)
            console.print(
                f"[blue]attest>[/] {record_hash}  "
                f"risk={record['decision']['risk']}  "
                f"verify={'ok' if ok else 'FAILED'}"
            )

    console.print("bye")


def _invoke(graph, payload: dict) -> AgentState:
    """Run a turn, resolving any human-approval interrupts.

    Current LangGraph returns a state with `__interrupt__`; older versions
    raised GraphInterrupt — both paths are handled.
    """
    try:
        state = graph.invoke(payload, CONFIG)
    except Exception as exc:
        if exc.__class__.__name__ != "GraphInterrupt":
            raise
        value = exc.value if isinstance(exc.value, list) else [exc.value]
        state = {"__interrupt__": value}
        state = _resolve_interrupt(graph, state)

    while state.get("__interrupt__"):
        state = _resolve_interrupt(graph, state)

    return state


def _resolve_interrupt(graph, state: dict) -> AgentState:
    interrupt = state["__interrupt__"][0]
    info = getattr(interrupt, "value", interrupt)

    console.print(
        f"[yellow]approval>[/] {info.get('question')}: "
        f"{info.get('intent')} {info.get('amount')} {info.get('unit', '')} "
        f"-> {info.get('recipient')} ({info.get('reason')})"
    )
    answer = console.input("[yellow]approve? (yes/no)>[/] ").strip().lower()
    approved = answer in {"yes", "y", "approve", "1"}

    from langgraph.types import Command

    return graph.invoke(Command(resume=approved), CONFIG)


if __name__ == "__main__":
    main()
