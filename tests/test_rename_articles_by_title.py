"""Behavioral tests for title-derived renames, links, and safe application."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "rename-articles-by-title.py"
spec = importlib.util.spec_from_file_location("article_renamer", SCRIPT)
renamer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = renamer
spec.loader.exec_module(renamer)


class TitleTests(unittest.TestCase):
    def test_title_entities_suffix_and_fallback(self):
        self.assertEqual(renamer.extract_title('<title> Go &amp; AI | AI 纪元 </title><h1>Other</h1>', 'old'), ('Go & AI', 'title'))
        self.assertEqual(renamer.extract_title('<title> </title><h1> A <em>real</em> title </h1>', 'old'), ('A real title', 'h1'))
        self.assertEqual(renamer.extract_title('<p>Body</p>', 'old'), ('old', 'filename'))
        self.assertEqual(renamer.extract_title('<title>Tool | Another site</title>', 'old'), ('Tool | Another site', 'title'))

    def test_filename_normalization_and_byte_bound(self):
        self.assertEqual(renamer.filename_for_title('A/B\\C:D*E?F"G<H>I|J.  '), 'A／B＼C：D＊E？F＂G＜H＞I｜J.html')
        self.assertEqual(renamer.filename_for_title('CON'), '_CON.html')
        self.assertEqual(renamer.filename_for_title('aux.txt'), '_aux.txt.html')
        self.assertEqual(renamer.filename_for_title('.NET 开发'), '_.NET 开发.html')
        self.assertEqual(renamer.filename_for_title('... '), '未命名.html')
        self.assertEqual(renamer.filename_for_title('Cafe\u0301\n title'), 'Café title.html')
        title = '长文章标题' * 90
        filename = renamer.filename_for_title(title)
        self.assertLessEqual(len(filename.encode()), 240)
        self.assertRegex(filename, r'~[0-9a-f]{12}\.html$')
        self.assertEqual(filename, renamer.filename_for_title(title))
        self.assertNotEqual(filename, renamer.filename_for_title(title + '变化'))


class RepoTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='rename-article-test-')
        self.root = Path(self.temporary.name)
        self.git('init', '-q')
        self.git('remote', 'add', 'origin', 'https://github.com/example/articles.git')

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.PIPE)

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode('utf-8'))
        return target

    def stage(self):
        self.git('add', '--all')

    def plan(self, **kwargs):
        return renamer.make_plan(self.root, **kwargs)

    def test_dry_run_and_apply_preserve_articles_and_modes(self):
        original = b'<!doctype html>\r\n<title>Real title</title>\r\n<p>content</p>\r\n'
        file = self.write('docs/topic/old.html', original.decode())
        file.chmod(0o755)
        self.stage()
        plan = self.plan()
        self.assertEqual(plan.report['summary']['renamed'], 1)
        self.assertTrue(file.exists())
        self.assertFalse((self.root / 'docs/topic/Real title.html').exists())
        self.assertEqual(plan.entries[0]['sha256'], renamer.digest(original))
        renamer.apply_plan(plan)
        new_file = self.root / 'docs/topic/Real title.html'
        self.assertEqual(new_file.read_bytes(), original)
        self.assertEqual(new_file.stat().st_mode & 0o777, 0o755)
        self.assertFalse(file.exists())
        self.assertEqual(list(self.root.glob('.title-rename-*')), [])
        self.stage()
        self.assertEqual(self.plan().report['summary']['renamed'], 0)

    def test_duplicate_titles_use_original_stem_and_are_idempotent(self):
        for stem in ('基础篇', 'Docker', 'Go'):
            self.write(f'docs/{stem}.html', '<title>基础篇</title>')
        self.stage()
        plan = self.plan()
        self.assertEqual(set(plan.mapping.values()), {'docs/基础篇.html', 'docs/基础篇（Docker）.html', 'docs/基础篇（Go）.html'})
        renamer.apply_plan(plan)
        self.stage()
        second = self.plan()
        self.assertEqual(second.report['summary']['renamed'], 0)
        self.assertEqual(second.replacements, {})

    def test_long_duplicate_titles_are_also_idempotent(self):
        for stem in ('Docker', 'Go（细节）'):
            self.write(f'docs/{stem}.html', '<title>' + '长标题' * 100 + '</title>')
        self.stage()
        plan = self.plan()
        self.assertTrue(all(len(Path(path).name.encode()) <= 240 for path in plan.mapping.values()))
        renamer.apply_plan(plan)
        self.stage()
        self.assertEqual(self.plan().replacements, {})

    def test_untracked_target_blocks_without_writes(self):
        original = self.write('docs/old.html', '<title>New</title>')
        self.stage()
        target = self.write('docs/new.HTML', 'untracked file must survive')
        with self.assertRaisesRegex(renamer.RenameError, 'already exists'):
            self.plan()
        self.assertEqual(original.read_text(), '<title>New</title>')
        self.assertEqual(target.read_text(), 'untracked file must survive')

    def test_final_collision_after_disambiguation_blocks(self):
        self.write('docs/A.html', '<title>T</title>')
        self.write('docs/B.html', '<title>T</title>')
        self.write('docs/C.html', '<title>T（A）</title>')
        self.stage()
        with self.assertRaisesRegex(renamer.RenameError, 'collide'):
            self.plan()

    def test_swapped_targets_move_without_losing_bytes(self):
        a = '<title>B</title><p>A content</p>'
        b = '<title>A</title><p>B content</p>'
        self.write('docs/A.html', a)
        self.write('docs/B.html', b)
        self.stage()
        renamer.apply_plan(self.plan())
        self.assertEqual((self.root / 'docs/A.html').read_text(), b)
        self.assertEqual((self.root / 'docs/B.html').read_text(), a)

    def test_scope_changes_only_selected_articles_but_updates_inbound_links(self):
        self.write('docs/one/old.html', '<title>New</title>')
        self.write('docs/two/keep.html', '<title>Would rename</title><a href="../one/old.html">One</a>')
        self.stage()
        plan = self.plan(scope='docs/one')
        self.assertEqual(plan.mapping, {'docs/one/old.html': 'docs/one/New.html'})
        self.assertIn(b'href="../one/New.html"', plan.replacements['docs/two/keep.html'])

    def test_changed_source_between_plan_and_apply_blocks(self):
        file = self.write('docs/old.html', '<title>New</title>')
        self.stage()
        plan = self.plan()
        file.write_text('<title>User edit</title>')
        with self.assertRaisesRegex(renamer.RenameError, 'changed since planning'):
            renamer.apply_plan(plan)
        self.assertEqual(file.read_text(), '<title>User edit</title>')

    def test_failed_apply_rolls_back_all_originals(self):
        self.write('docs/A.html', '<title>First</title>')
        self.write('docs/B.html', '<title>Second</title>')
        self.stage()
        plan = self.plan()
        real_replace = renamer.os.replace
        def failing_replace(source, destination):
            if Path(source).parent.name == 'new' and Path(source).name == '1':
                raise OSError('simulated disk error')
            return real_replace(source, destination)
        with patch.object(renamer.os, 'replace', side_effect=failing_replace):
            with self.assertRaisesRegex(OSError, 'simulated disk error'):
                renamer.apply_plan(plan)
        self.assertEqual((self.root / 'docs/A.html').read_bytes(), plan.originals['docs/A.html'])
        self.assertEqual((self.root / 'docs/B.html').read_bytes(), plan.originals['docs/B.html'])
        self.assertFalse((self.root / 'docs/First.html').exists())
        self.assertFalse((self.root / 'docs/Second.html').exists())

    def test_symlink_source_is_rejected(self):
        self.write('real.html', '<title>Do not edit</title>')
        (self.root / 'docs').mkdir()
        (self.root / 'docs/old.html').symlink_to('../real.html')
        self.stage()
        with self.assertRaisesRegex(renamer.RenameError, 'Symlink'):
            self.plan()

    def test_failed_postwrite_verification_rolls_back_all_originals(self):
        self.write('docs/A.html', '<title>First</title>')
        self.write('docs/B.html', '<title>Second</title>')
        self.stage()
        plan = self.plan()
        real_read = renamer.read_regular
        def failing_read(root, relative):
            if relative == 'docs/First.html':
                return b'simulated corruption'
            return real_read(root, relative)
        with patch.object(renamer, 'read_regular', side_effect=failing_read):
            with self.assertRaisesRegex(renamer.RenameError, 'Post-write verification failed'):
                renamer.apply_plan(plan)
        for path, original in plan.originals.items():
            self.assertEqual((self.root / path).read_bytes(), original)
        self.assertFalse((self.root / 'docs/First.html').exists())
        self.assertFalse((self.root / 'docs/Second.html').exists())
        self.assertEqual(list(self.root.glob('.title-rename-*')), [])

    def test_failed_rollback_preserves_recovery_backups_and_manifest(self):
        self.write('docs/A.html', '<title>First</title>')
        self.write('docs/B.html', '<title>Second</title>')
        self.stage()
        plan = self.plan()
        real_read = renamer.read_regular
        real_replace = renamer.os.replace
        def failing_read(root, relative):
            if relative == 'docs/First.html':
                return b'simulated corruption'
            return real_read(root, relative)
        def failing_rollback(source, destination):
            if Path(source).parent.name == 'originals':
                raise OSError('simulated rollback error')
            return real_replace(source, destination)
        with patch.object(renamer, 'read_regular', side_effect=failing_read), patch.object(renamer.os, 'replace', side_effect=failing_rollback):
            with self.assertRaisesRegex(OSError, 'simulated rollback error'):
                renamer.apply_plan(plan)
        transactions = list(self.root.glob('.title-rename-*'))
        self.assertEqual(len(transactions), 1)
        backup = transactions[0] / 'originals'
        self.assertEqual((backup / '0').read_bytes(), plan.originals['docs/A.html'])
        self.assertEqual((backup / '1').read_bytes(), plan.originals['docs/B.html'])
        self.assertEqual(len(json.loads((transactions[0] / 'manifest.json').read_text())['files']), 2)

    def test_cli_check_and_report(self):
        self.write('docs/old.html', '<title>New</title>')
        self.stage()
        report = self.root / 'migration-report.json'
        result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(self.root), '--check', '--report', str(report)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(report.read_text())['mode'], 'dry-run')
        self.assertTrue((self.root / 'docs/old.html').exists())
        renamer.apply_plan(self.plan())
        self.stage()
        result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(self.root), '--check'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class LinkTests(unittest.TestCase):
    def rewriter(self):
        return renamer.LinkRewriter({'docs/topic/old.html': 'docs/topic/真实标题.html'}, {'docs/topic/old.html', 'index.html', 'docs/other.html'}, ['https://example.github.io/articles/'])

    def test_html_links_rewrite_only_real_attributes(self):
        encoded = quote('真实标题') + '.html'
        content = '''<title>Keep old.html</title>
<a href='old.html?q=%2F&amp;b=two#part%20one'>Link</a>
<iframe src=old.html></iframe><form action="/articles/docs/topic/old.html?x#y"></form>
<a href="https://example.github.io/articles/docs/topic/old.html?x=%2f#abc">Pages</a>
<a href="https://external.example/docs/topic/old.html">External</a>
<pre><code><a href="old.html">sample</a></code></pre>
<script>const sample = '<a href="old.html">';</script>
<!-- <a href="old.html">Comment</a> --><p>old.html</p>'''
        rw = self.rewriter()
        output = renamer.rewrite_document(content, 'docs/topic/source.html', rw)
        self.assertIn(f"href='{encoded}?q=%2F&amp;b=two#part%20one'", output)
        self.assertIn(f'src="{encoded}"', output)
        self.assertIn(f'action="/articles/docs/topic/{encoded}?x#y"', output)
        self.assertIn(f'https://example.github.io/articles/docs/topic/{encoded}?x=%2f#abc', output)
        self.assertIn('<a href="https://external.example/docs/topic/old.html">', output)
        self.assertIn('<pre><code><a href="old.html">sample</a></code></pre>', output)
        self.assertIn('<script>const sample = \'<a href="old.html">\';</script>', output)
        self.assertIn('<!-- <a href="old.html">Comment</a> --><p>old.html</p>', output)
        self.assertEqual(rw.audit()['rewrittenLinks'], 4)
        self.assertEqual(rw.audit()['newBrokenLinks'], [])

    def test_markdown_links_and_reference_definitions_skip_code(self):
        content = '''[Read](docs/topic/old.html?x=%2F#section "title")
[space](<docs/topic/old.html>)
[ref]: docs/topic/old.html#ref "Title"
`[example](docs/topic/old.html)`
```md
[example](docs/topic/old.html)
<a href="docs/topic/old.html">sample</a>
```
    [indented example](docs/topic/old.html)
<code>[sample](docs/topic/old.html)</code>
<a href="docs/topic/old.html">HTML link</a>
Plain docs/topic/old.html and ](docs/topic/old.html).
'''
        rw = self.rewriter()
        output = renamer.rewrite_document(content, 'README.md', rw)
        encoded = 'docs/topic/' + quote('真实标题') + '.html'
        self.assertIn(f'[Read]({encoded}?x=%2F#section "title")', output)
        self.assertIn(f'[space](<{encoded}>)', output)
        self.assertIn(f'[ref]: {encoded}#ref "Title"', output)
        self.assertIn('`[example](docs/topic/old.html)`', output)
        self.assertIn('```md\n[example](docs/topic/old.html)', output)
        self.assertIn('    [indented example](docs/topic/old.html)', output)
        self.assertIn('<code>[sample](docs/topic/old.html)</code>', output)
        self.assertIn(f'<a href="{encoded}">HTML link</a>', output)
        self.assertIn('Plain docs/topic/old.html and ](docs/topic/old.html).', output)
        self.assertEqual(rw.audit()['rewrittenLinks'], 4)

    def test_encoded_path_relative_root_prefix_and_empty_suffixes(self):
        rw = self.rewriter()
        encoded = quote('真实标题') + '.html'
        for old, expected in [
            ('./old.html?#', './' + encoded + '?#'),
            ('/docs/topic/old.html?x=%2f#', '/docs/topic/' + encoded + '?x=%2f#'),
            ('//example.github.io/articles/docs/topic/old.html', '//example.github.io/articles/docs/topic/' + encoded),
            ('https://example.github.io/another/docs/topic/old.html', 'https://example.github.io/another/docs/topic/old.html'),
        ]:
            self.assertEqual(rw.rewrite('docs/topic/source.html', old), expected)

    def test_existing_broken_links_are_reported_separately(self):
        rw = self.rewriter()
        renamer.rewrite_document('<a href="missing.html">missing</a><a href="../../index.html">home</a>', 'docs/topic/source.html', rw)
        self.assertEqual(rw.audit()['localHtmlLinksChecked'], 2)
        self.assertEqual(len(rw.audit()['preExistingBrokenLinks']), 1)
        self.assertEqual(rw.audit()['newBrokenLinks'], [])


if __name__ == '__main__':
    unittest.main()
