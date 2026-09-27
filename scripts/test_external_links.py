import unittest

from external_links import normalize_html


class ExternalLinksTest(unittest.TestCase):
    def test_external_sources_open_without_javascript(self):
        source = '<p><a href="https://github.com/vercel-labs/skills">Skills</a></p>\n<a href="//example.com/help">Help</a>'
        result, parser = normalize_html(source)
        self.assertEqual(parser.external_count, 2)
        self.assertEqual(result, '<p><a href="https://github.com/vercel-labs/skills" target="_blank" rel="noopener noreferrer">Skills</a></p>\n<a href="//example.com/help" target="_blank" rel="noopener noreferrer">Help</a>')
        self.assertEqual(normalize_html(result)[0], result)
        self.assertFalse(normalize_html(result)[1].edits)

    def test_navigation_and_downloads_are_unchanged(self):
        source = '''<a href="#section">Anchor</a>
<a href="../AI%20Agent/Article.html#section">Article</a>
<a href="https://ketitongxue.github.io/ai-era-html-docs/docs/a.html">Local absolute</a>
<a href="//ketitongxue.github.io/ai-era-html-docs/docs/a.html">Local protocol relative</a>
<a href="https://example.com/file.pdf" download="reference.pdf">Download</a>
<a href="mailto:reader@example.com">Email</a>
<a href="tel:123">Call</a>'''
        result, parser = normalize_html(source)
        self.assertEqual(result, source)
        self.assertEqual(parser.external_count, 0)

    def test_existing_attributes_and_href_are_preserved(self):
        source = "<A class='source' HREF='https://example.com/?target=test&amp;q=a' TARGET='_self' REL='nofollow NOOPENER' data-target='keep'>Source</A>"
        result, _ = normalize_html(source)
        self.assertEqual(result, "<A class='source' HREF='https://example.com/?target=test&amp;q=a' target=\"_blank\" rel=\"nofollow NOOPENER noreferrer\" data-target='keep'>Source</A>")

    def test_scripts_code_comments_and_images_are_unchanged(self):
        source = '''<script>const example = '<a href="https://example.com">';</script>
<!-- <a href="https://example.com">example</a> -->
<pre><code>&lt;a href="https://example.com"&gt;</code></pre>
<img src="../../assets/image.png" alt="example">
<a href="https://example.com" target="_blank" rel="noopener noreferrer sponsored">Source</a>'''
        self.assertEqual(normalize_html(source)[0], source)


if __name__ == "__main__":
    unittest.main()
