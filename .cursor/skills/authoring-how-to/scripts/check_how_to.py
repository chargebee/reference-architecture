#!/usr/bin/env python3
"""Validate a reference-architecture how-to guide.

Checks structure, mermaid-only diagrams, link integrity, and the language rules
described in references/language.md.

    python3 check_how_to.py how-to/integrating-chargebee-webhooks.md
    python3 check_how_to.py how-to/*.md --strict --external
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import urllib.error
import urllib.request

REQUIRED_SECTIONS = [
    "High level architecture",
    "Best Practices",
    "Implementation notes",
    "Go-live checklist",
]

# Unambiguous marketing or generated-prose tells.
def inflect(verb: str) -> list[str]:
    """Every form of a banned verb, so 'utilizes' is caught alongside 'utilize'."""
    if verb.endswith("e"):
        return [verb, verb + "s", verb + "d", verb[:-1] + "ing"]
    return [verb, verb + "s", verb + "ed", verb + "ing"]


BANNED_VERBS_ERROR = [
    "utilize", "facilitate", "delve", "elevate", "empower", "streamline",
    "unlock", "supercharge", "unpack",
]

BANNED_ERROR = [
    "seamless", "seamlessly", "robust", "powerful", "comprehensive",
    "dive into", "holistic",
    "synergy", "myriad", "plethora", "paramount", "bespoke", "meticulous",
    "meticulously", "boasts", "game-changer", "game changer", "cutting-edge",
    "best-in-class", "state-of-the-art", "world-class", "tapestry",
    "testament to", "navigate the complexities", "in today's fast-paced",
    "in the world of", "when it comes to", "ever-evolving",
    "it is worth noting", "it's worth noting", "it is important to note",
    "keep in mind that", "needless to say", "at the end of the day",
    "in conclusion", "in summary", "to sum up", "this guide will explore",
    "this guide will cover", "this article will", "let's dive in",
    "we'll explore", "we will explore", "crucial", "vital role",
    "pivotal role", "key takeaway", "rest assured", "look no further",
    "and more!", "as an ai", "certainly!", "great question",
    "might want to consider",
] + [form for verb in BANNED_VERBS_ERROR for form in inflect(verb)]

# Legitimate in the right technical context, but usually a tell.
BANNED_WARN = [
    "harness", "foster", "embark", "underscore", "underscores", "realm",
    "landscape", "very", "really", "extremely", "incredibly",
] + inflect("leverage") + inflect("explore")

# Filler only when they open a sentence; fine mid-sentence.
BANNED_OPENERS = ["additionally", "furthermore", "moreover", "overall", "notably"]

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".pdf")

DIAGRAM_HOSTS = (
    "lucid.app", "lucidchart", "miro.com", "excalidraw", "draw.io",
    "diagrams.net", "figma.com", "whimsical.com", "mermaid.live",
)

MERMAID_TYPES = (
    "sequenceDiagram", "flowchart", "graph", "stateDiagram-v2", "stateDiagram",
    "erDiagram", "classDiagram", "gantt", "journey", "timeline", "block-beta",
    "C4Context",
)

MERMAID_BLOCK_OPENERS = ("alt", "loop", "opt", "par", "critical", "rect", "box", "subgraph")

# pointer's technology choices, which do not belong in a neutral architecture diagram.
VENDOR_TERMS = (
    "SQS", "SNS", "Kinesis", "RabbitMQ", "Kafka", "Lambda", "DynamoDB",
    "Postgres", "PostgreSQL", "MySQL", "Redis", "Next.js", "NextJS",
    "Better Auth", "BetterAuth", "Vercel", "Cloudflare", "Drizzle", "Prisma",
)

EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\U00002B00-\U00002BFF]"
)

LINK = re.compile(r"(!?)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+\"[^\"]*\")?\s*\)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
BULLET = re.compile(r"^(\s*)([-*+])\s+(.*)$")
CHECKBOX = re.compile(r"^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$")


class Report:
    def __init__(self, path: str) -> None:
        self.path = path
        self.errors: list[tuple[int, str]] = []
        self.warnings: list[tuple[int, str]] = []

    def error(self, line: int, message: str) -> None:
        self.errors.append((line, message))

    def warn(self, line: int, message: str) -> None:
        self.warnings.append((line, message))

    def render(self) -> None:
        print(f"\n{self.path}")
        if not self.errors and not self.warnings:
            print("  ok")
            return
        for line, message in sorted(self.errors):
            print(f"  ERROR   {self.path}:{line}: {message}")
        for line, message in sorted(self.warnings):
            print(f"  WARN    {self.path}:{line}: {message}")
        print(f"  {len(self.errors)} error(s), {len(self.warnings)} warning(s)")


def normalize(text: str) -> str:
    """Fold smart punctuation so phrase matching is not defeated by typography."""
    return (
        text.replace("\u2019", "'").replace("\u2018", "'")
        .replace("\u201c", '"').replace("\u201d", '"')
    )


def find_fences(lines: list[str]) -> list[dict]:
    """Return fenced code blocks as {lang, start, end, body} with 0-based indices."""
    fences: list[dict] = []
    open_fence: dict | None = None
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)(`{3,})(.*)$", line)
        if not match:
            continue
        marker, info = match.group(2), match.group(3).strip()
        if open_fence is None:
            open_fence = {"lang": info.split()[0] if info else "", "start": index,
                          "marker": marker, "body": []}
        elif marker[: len(open_fence["marker"])] == open_fence["marker"] and not info:
            open_fence["end"] = index
            fences.append(open_fence)
            open_fence = None
    if open_fence is not None:
        open_fence["end"] = len(lines) - 1
        open_fence["unclosed"] = True
        fences.append(open_fence)
    for fence in fences:
        fence["body"] = lines[fence["start"] + 1: fence["end"]]
    return fences


def mask(lines: list[str], fences: list[dict]) -> list[str]:
    """Blank out code so prose checks never fire on code samples."""
    masked = list(lines)
    for fence in fences:
        for index in range(fence["start"], min(fence["end"] + 1, len(masked))):
            masked[index] = ""
    for index, line in enumerate(masked):
        masked[index] = re.sub(r"`[^`]*`", lambda m: " " * len(m.group(0)), line)
    return masked


def slugify(title: str) -> str:
    text = re.sub(r"`", "", title.lower())
    text = re.sub(r"[^\w\- ]", "", text)
    return text.strip().replace(" ", "-")


def phrase_pattern(phrase: str) -> re.Pattern:
    body = re.escape(phrase).replace(r"\ ", r"\s+").replace("'", "['\u2019]")
    lead = r"\b" if phrase[0].isalnum() else ""
    tail = r"\b" if phrase[-1].isalnum() else ""
    return re.compile(lead + body + tail, re.IGNORECASE)


def opener_pattern(word: str) -> re.Pattern:
    return re.compile(r"(?:^|[.!?]\s+)[\s\-*+>]*(?:\*\*|__)?" + re.escape(word) + r"\b",
                      re.IGNORECASE)


BANNED_ERROR_PATTERNS = [(p, phrase_pattern(p)) for p in BANNED_ERROR]
BANNED_WARN_PATTERNS = [(p, phrase_pattern(p)) for p in BANNED_WARN]
BANNED_OPENER_PATTERNS = [(p, opener_pattern(p)) for p in BANNED_OPENERS]


def check_headings(lines: list[str], masked: list[str], report: Report) -> list[dict]:
    headings = []
    for index, line in enumerate(masked):
        match = HEADING.match(line)
        if match:
            headings.append({"level": len(match.group(1)), "title": match.group(2),
                             "line": index})

    h1s = [h for h in headings if h["level"] == 1]
    if not h1s:
        report.error(1, "no H1 title found")
    elif len(h1s) > 1:
        report.error(h1s[1]["line"] + 1, f"{len(h1s)} H1 headings; a guide has exactly one")
    if h1s and not re.match(r"^How to \S", h1s[0]["title"]):
        report.error(h1s[0]["line"] + 1,
                     f"title must start with 'How to ' and name an outcome: {h1s[0]['title']!r}")

    h2_titles = [h["title"] for h in headings if h["level"] == 2]
    positions = []
    for required in REQUIRED_SECTIONS:
        if required not in h2_titles:
            report.error(1, f"missing required section '## {required}'")
        else:
            positions.append(h2_titles.index(required))
    if len(positions) == len(REQUIRED_SECTIONS) and positions != sorted(positions):
        report.error(1, "required sections are out of order; expected "
                        + " then ".join(REQUIRED_SECTIONS))

    for heading in headings:
        if heading["level"] >= 2 and heading["title"] not in ("Best Practices",):
            words = [w for w in heading["title"].split() if w.isalpha() and len(w) > 3]
            capitalized = [w for w in words[1:] if w[0].isupper()]
            if words and len(capitalized) >= max(2, len(words) // 2):
                report.warn(heading["line"] + 1,
                            f"heading looks title-cased; use sentence case: {heading['title']!r}")
    return headings


def section_bounds(headings: list[dict], title: str, total: int) -> tuple[int, int] | None:
    for position, heading in enumerate(headings):
        if heading["title"] == title:
            start = heading["line"]
            end = total
            for later in headings[position + 1:]:
                if later["level"] <= heading["level"]:
                    end = later["line"]
                    break
            return start, end
    return None


def check_diagrams(lines: list[str], fences: list[dict], headings: list[dict],
                   report: Report) -> None:
    for fence in fences:
        if fence.get("unclosed"):
            report.error(fence["start"] + 1, "unclosed code fence")

    mermaid = [f for f in fences if f["lang"].lower() == "mermaid"]
    if not mermaid:
        report.error(1, "no mermaid diagram found; every diagram must be a mermaid code block")

    bounds = section_bounds(headings, "High level architecture", len(lines))
    if bounds:
        start, end = bounds
        in_section = [f for f in mermaid if start < f["start"] < end]
        if not in_section:
            report.error(start + 1, "'High level architecture' has no mermaid diagram")
        else:
            architecture = in_section[0]
            for offset, line in enumerate(architecture["body"]):
                for term in VENDOR_TERMS:
                    if re.search(rf"\b{re.escape(term)}\b", line):
                        report.warn(architecture["start"] + 2 + offset,
                                    f"'{term}' is a pointer implementation choice; keep the "
                                    "architecture diagram technology-neutral and move it to "
                                    "'Implementation notes'")
            prose = " ".join(
                l.strip() for l in lines[architecture["end"] + 1: end]
                if l.strip() and not l.strip().startswith("#")
            )
            if len(prose) < 200:
                report.warn(architecture["end"] + 1,
                            "the architecture diagram is not followed by enough prose to stand "
                            "on its own")

    for fence in mermaid:
        body = [l for l in fence["body"] if l.strip() and not l.strip().startswith("%%")]
        if not body:
            report.error(fence["start"] + 1, "empty mermaid block")
            continue
        first = body[0].strip()
        if not any(first.startswith(kind) for kind in MERMAID_TYPES):
            report.warn(fence["start"] + 2, f"unrecognized mermaid diagram type: {first!r}")

        openers = 0
        ends = 0
        for line in body:
            token = line.strip().split()[0] if line.strip().split() else ""
            if token in MERMAID_BLOCK_OPENERS:
                openers += 1
            elif token == "end":
                ends += 1
        if openers != ends:
            report.error(fence["start"] + 1,
                         f"mermaid block has {openers} block opener(s) but {ends} 'end'(s)")

        if first.startswith("sequenceDiagram"):
            declared = set()
            for line in body:
                match = re.match(r"^\s*(?:participant|actor)\s+(\w+)", line)
                if match:
                    declared.add(match.group(1))
            used: set[str] = set()
            for line in body:
                arrow = re.match(r"^\s*(\w+)\s*(?:-{1,2}>>?|-{1,2}\)|-{1,2}x|<<-->>)\s*\+?(\w+)",
                                 line)
                if arrow:
                    used.update(arrow.groups())
                for keyword in ("activate", "deactivate"):
                    single = re.match(rf"^\s*{keyword}\s+(\w+)", line)
                    if single:
                        used.add(single.group(1))
            undeclared = sorted(used - declared)
            if undeclared:
                report.warn(fence["start"] + 1,
                            "participant(s) used but never declared: " + ", ".join(undeclared))


def check_images_and_links(lines: list[str], masked: list[str], headings: list[dict],
                           report: Report, doc_path: str, check_external: bool) -> None:
    anchors = {slugify(h["title"]) for h in headings}
    doc_dir = os.path.dirname(os.path.abspath(doc_path))
    external: list[tuple[int, str]] = []

    for index, line in enumerate(masked):
        line_number = index + 1
        if re.search(r"<img\b", line, re.IGNORECASE):
            report.error(line_number, "HTML <img> tag; diagrams must be mermaid code blocks")
        if "<!--" in line:
            report.error(line_number, "HTML comment left in the document; strip template comments")

        for bang, text, target in LINK.findall(line):
            if bang == "!":
                report.error(line_number,
                             f"embedded image {target!r}; everything is code, so express "
                             "diagrams as mermaid blocks")
                continue
            lowered = target.lower()
            if lowered.endswith(IMAGE_EXTENSIONS):
                report.error(line_number, f"link to a binary/image asset: {target}")
            if any(host in lowered for host in DIAGRAM_HOSTS):
                report.error(line_number,
                             f"link to an external diagram tool ({target}); commit the diagram "
                             "as mermaid instead")
            if re.match(r"^(https?:|mailto:)", lowered):
                if not text.strip():
                    report.warn(line_number, f"link with empty text: {target}")
                elif text.strip().lower() in ("here", "click here", "this", "link"):
                    report.warn(line_number, f"uninformative link text: {text!r}")
                if lowered.startswith("http"):
                    external.append((line_number, target))
                continue
            if target.startswith("#"):
                if slugify(target[1:]) not in anchors:
                    report.error(line_number, f"in-page anchor does not match any heading: {target}")
                continue
            path_part = target.split("#", 1)[0]
            if not path_part:
                continue
            resolved = os.path.normpath(os.path.join(doc_dir, path_part))
            if not os.path.exists(resolved):
                report.error(line_number, f"relative link does not resolve: {target}")

    if check_external:
        for line_number, url in external:
            status = probe(url)
            if status in (404, 410):
                report.error(line_number, f"external link returns HTTP {status}: {url}")
            elif status is None:
                report.warn(line_number, f"external link could not be fetched: {url}")
            elif status >= 400:
                report.warn(line_number, f"external link returns HTTP {status}: {url}")


def probe(url: str) -> int | None:
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "check-how-to"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return None


def check_language(masked: list[str], report: Report) -> None:
    url_free = [re.sub(r"\]\([^)]*\)", "]()", re.sub(r"https?://\S+", "", line))
                for line in masked]
    for index, raw in enumerate(url_free):
        line = normalize(raw)
        line_number = index + 1
        for phrase, pattern in BANNED_ERROR_PATTERNS:
            if pattern.search(line):
                report.error(line_number, f"banned phrase {phrase!r}; see references/language.md")
        for phrase, pattern in BANNED_WARN_PATTERNS:
            if pattern.search(line):
                report.warn(line_number,
                            f"{phrase!r} is usually filler or marketing; rewrite unless it "
                            "carries precise technical meaning")
        for phrase, pattern in BANNED_OPENER_PATTERNS:
            if pattern.search(line):
                report.warn(line_number,
                            f"{phrase!r} opens a sentence as filler; start with the point")
        if EMOJI.search(line):
            report.error(line_number, "emoji are not used in these guides")
        for wrong in re.findall(r"\b(?:chargebee|ChargeBee|CHARGEBEE|Chargbee|Charge Bee)\b", line):
            report.warn(line_number, f"capitalize the product name as 'Chargebee', not {wrong!r}")


def check_rhetorical_questions(lines: list[str], masked: list[str], headings: list[dict],
                               report: Report) -> None:
    """The go-live checklist is the only place a question belongs."""
    bounds = section_bounds(headings, "Go-live checklist", len(lines))
    for index, line in enumerate(masked):
        stripped = line.strip()
        if not stripped.endswith("?") or stripped.startswith(("#", "|", ">")):
            continue
        if bounds and bounds[0] <= index < bounds[1]:
            continue
        report.warn(index + 1, "rhetorical question in prose; state the answer instead. "
                               "Questions belong in the go-live checklist")


def check_bullet_cadence(masked: list[str], headings: list[dict], report: Report) -> None:
    boundaries = [h["line"] for h in headings] + [len(masked)]
    for position in range(len(boundaries) - 1):
        start, end = boundaries[position], boundaries[position + 1]
        bullets = []
        for index in range(start, end):
            match = BULLET.match(masked[index])
            if match and len(match.group(1)) <= 3 and not CHECKBOX.match(masked[index]):
                bullets.append((index, match.group(3).strip()))
        if len(bullets) < 4:
            continue
        bolded = [i for i, text in bullets if text.startswith("**") or text.startswith("__")]
        if len(bolded) / len(bullets) >= 0.7:
            report.warn(start + 1,
                        f"{len(bolded)} of {len(bullets)} bullets in this section open with a "
                        "bold label; that cadence reads as generated. Bold only genuine named "
                        "concepts")


def check_checklist(lines: list[str], masked: list[str], headings: list[dict],
                    report: Report) -> None:
    bounds = section_bounds(headings, "Go-live checklist", len(lines))
    if not bounds:
        return
    start, end = bounds
    items = []
    for index in range(start + 1, end):
        line = masked[index]
        checkbox = CHECKBOX.match(line)
        if checkbox:
            items.append((index, checkbox.group(2).strip()))
        elif BULLET.match(line) and len(BULLET.match(line).group(1)) <= 3:
            report.error(index + 1, "checklist entries must use '- [ ] ' checkbox syntax")
    if not items:
        report.error(start + 1, "'Go-live checklist' has no checkbox items")
    elif len(items) < 3:
        report.warn(start + 1, f"only {len(items)} checklist item(s); cover configuration, "
                               "correctness, failure recovery, and observability")
    for index, text in items:
        if not text.rstrip().endswith("?"):
            report.warn(index + 1, "phrase checklist items as a question with a testable answer")
        if len(text.split()) < 5:
            report.warn(index + 1, f"checklist item is too vague to test: {text!r}")

    last = next((l.strip() for l in reversed(lines) if l.strip()), "")
    if items and not CHECKBOX.match(last):
        report.warn(len(lines), "the guide should end on the last checklist item; drop any "
                                "closing summary")


def check_implementation_notes(lines: list[str], masked: list[str], headings: list[dict],
                               report: Report) -> None:
    bounds = section_bounds(headings, "Implementation notes", len(lines))
    if not bounds:
        return
    start, end = bounds
    body = "\n".join(masked[start:end])
    if "pointer" not in body:
        report.warn(start + 1, "'Implementation notes' should connect the guidance to the "
                               "pointer app")
    if not re.search(r"\]\(\.\./pointer/", body):
        report.warn(start + 1, "'Implementation notes' has no relative link into ../pointer/")


def check_file(path: str, check_external: bool) -> Report:
    report = Report(path)
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().split("\n")

    fences = find_fences(lines)
    masked = mask(lines, fences)
    headings = check_headings(lines, masked, report)
    check_diagrams(lines, fences, headings, report)
    check_images_and_links(lines, masked, headings, report, path, check_external)
    check_language(masked, report)
    check_rhetorical_questions(lines, masked, headings, report)
    check_bullet_cadence(masked, headings, report)
    check_checklist(lines, masked, headings, report)
    check_implementation_notes(lines, masked, headings, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate reference-architecture how-to guides.")
    parser.add_argument("paths", nargs="+", help="markdown files under how-to/")
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    parser.add_argument("--external", action="store_true",
                        help="also fetch every external link and report bad status codes")
    args = parser.parse_args()

    reports = []
    for path in args.paths:
        if not os.path.isfile(path):
            print(f"ERROR: not a file: {path}", file=sys.stderr)
            return 2
        report = check_file(path, args.external)
        report.render()
        reports.append(report)

    errors = sum(len(r.errors) for r in reports)
    warnings = sum(len(r.warnings) for r in reports)
    print(f"\n{len(reports)} file(s): {errors} error(s), {warnings} warning(s)")
    if errors or (args.strict and warnings):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
