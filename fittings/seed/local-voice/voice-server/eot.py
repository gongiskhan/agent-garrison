"""
End-of-turn scoring — the semantic half of the HUD's smart endpointing.

score_eot(text) -> probability [0..1] that the utterance is COMPLETE (the
speaker is done, not pausing mid-thought). The HUD sizes its post-VAD grace
window from this: high score → short wait before sending, low score → long
tolerance for a thinking pause.

Why a heuristic and not a model (v1): whisper large-v3 already emits prosody-
aware punctuation — a trailing "..." on speech that tails off, a "?" on a real
question — so the transcript itself carries most of the end-of-turn signal.
Reading it costs ~0ms and stays fully local. A dedicated end-of-turn model
(e.g. LiveKit's open turn-detector ONNX, multilingual incl. PT) can replace
this behind the same score_eot() signature without touching any consumer; do
that if the heuristic proves too coarse in daily use.

Pure module — no heavy imports — so it is testable standalone:
  python eot.py "Quero que tu"     -> prints the score
"""

import re

# Words that (almost) never end a finished thought: connectives, prepositions,
# articles, fillers. Trailing one of these = the speaker is mid-sentence.
# PT and EN are merged into one set — the overlap is harmless (a false "complete
# → incomplete" demotion just waits a bit longer, never cuts the user off).
_INCOMPLETE_WORDS = {
    # pt — conjunções / preposições / artigos / fillers
    "e", "mas", "ou", "que", "porque", "se", "como", "quando", "onde",
    "para", "pra", "com", "sem", "de", "do", "da", "dos", "das",
    "no", "na", "nos", "nas", "ao", "aos", "à", "às", "pelo", "pela",
    "o", "a", "os", "as", "um", "uma", "uns", "umas",
    "meu", "minha", "teu", "tua", "seu", "sua", "nosso", "nossa",
    "este", "esta", "esse", "essa", "aquele", "aquela", "isto", "isso",
    "então", "portanto", "pois", "tipo", "depois", "antes", "entre",
    "hum", "hmm", "ah", "eh", "uh", "é", "era", "está", "estão", "são",
    "quero", "queria", "vou", "vais", "vamos", "podes", "pode",
    "eu", "tu", "ele", "ela", "nós", "eles", "elas", "você", "vocês",
    "me", "te", "lhe", "nos",
    # en — conjunctions / prepositions / articles / fillers
    "and", "but", "or", "so", "because", "if", "when", "then", "that",
    "which", "to", "of", "with", "without", "in", "on", "at", "for",
    "from", "by", "the", "an", "my", "your", "his", "her", "its",
    "our", "their", "this", "these", "those", "um", "like", "actually",
    "basically", "well", "i", "you", "he", "she", "we", "they", "it",
    "is", "are", "was", "were", "want", "wanna", "gonna", "please",
}

_TRAILING_PUNCT = re.compile(r"[\s\.,;:!\?…\-—–\"'”’»\)\]]+$")


def _last_word(text: str) -> str:
    stripped = _TRAILING_PUNCT.sub("", text)
    parts = stripped.split()
    return parts[-1].lower() if parts else ""


def score_eot(text: str) -> float:
    """Probability that `text` is a finished utterance. Cheap, local, PT+EN."""
    t = (text or "").strip()
    if not t:
        return 1.0  # nothing pending — nothing to wait for
    # whisper writes "..."/"…" when the voice trails off — the strongest
    # incomplete cue we get. Check before generic terminal punctuation
    # ("..." ends with "." too).
    if t.endswith("…") or t.endswith("..."):
        return 0.2
    if t[-1] in ",;:—–-":
        return 0.15
    incomplete_word = _last_word(t) in _INCOMPLETE_WORDS
    if t[-1] in ".!?":
        # Terminal punctuation usually means done — unless the final word is a
        # connective ("para.", "and."): whisper often stamps a period on a
        # mid-thought pause, so the word signal wins over the punctuation.
        if incomplete_word:
            return 0.25
        return 0.95 if t[-1] == "?" else 0.9
    if incomplete_word:
        return 0.1
    # No terminal punctuation at all — whisper was unsure the voice was final.
    return 0.45


if __name__ == "__main__":
    import sys
    samples = sys.argv[1:] or [
        "Que horas são em Lisboa?",
        "Liga as luzes da sala.",
        "Quero que tu",
        "Faz uma pesquisa sobre, hum...",
        "E depois disso, quero que",
        "Manda um email ao João",
        "I want you to",
        "Turn off the lights.",
    ]
    for s in samples:
        print(f"{score_eot(s):.2f}  {s!r}")
