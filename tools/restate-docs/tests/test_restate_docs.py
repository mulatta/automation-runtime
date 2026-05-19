import importlib.util
import sys
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "main.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "restate-docs"

loader = SourceFileLoader("restate_docs_cli", str(SCRIPT))
spec = importlib.util.spec_from_loader("restate_docs_cli", loader)
assert spec is not None
restate_docs_cli = importlib.util.module_from_spec(spec)
sys.modules["restate_docs_cli"] = restate_docs_cli
loader.exec_module(restate_docs_cli)


class RestateDocsCliTest(unittest.TestCase):
    def test_parse_llms_index_generates_stable_ids(self) -> None:
        items = restate_docs_cli.parse_llms_index(
            (FIXTURES / "llms.txt").read_text(encoding="utf-8")
        )

        self.assertEqual(items[0].id, "kafka-ingress")
        self.assertEqual(items[0].title, "Kafka ingress")
        self.assertEqual(
            items[0].url, "https://docs.restate.dev/guides/kafka-ingress.md"
        )
        self.assertIn("start workflows", items[0].description)

    def test_search_prefers_title_and_description_matches(self) -> None:
        items = restate_docs_cli.parse_llms_index(
            (FIXTURES / "llms.txt").read_text(encoding="utf-8")
        )

        results = restate_docs_cli.search_index(items, "Kafka server", limit=2)

        self.assertEqual(results[0].item.id, "kafka-ingress")
        self.assertEqual(results[1].item.id, "server-configuration")
        self.assertGreater(results[0].score, results[1].score)

    def test_extract_snippets_prefers_matching_heading_and_code(self) -> None:
        markdown = (FIXTURES / "kafka.md").read_text(encoding="utf-8")

        snippets = restate_docs_cli.extract_snippets(
            markdown,
            "TypeScript handler ctx.run",
            max_chars=500,
        )

        self.assertIn("## TypeScript handler", snippets)
        self.assertIn("```ts", snippets)
        self.assertIn("ctx.run", snippets)
        self.assertNotIn("## Java handler", snippets)

    def test_resolve_target_accepts_exact_id(self) -> None:
        items = restate_docs_cli.parse_llms_index(
            (FIXTURES / "llms.txt").read_text(encoding="utf-8")
        )

        item = restate_docs_cli.resolve_target(items, "server-configuration")

        self.assertEqual(item.url, "https://docs.restate.dev/operate/configuration/server.md")


if __name__ == "__main__":
    unittest.main()
