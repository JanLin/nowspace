"""A URL fragment is not a tag.

The tag strip matched `#all/<id>` inside a Gmail link, so a week line's
thread link survived scheduling and died at the first save — silently, and
on every task with a fragment URL, not just externally scheduled ones.
"""

from backend.agents.obsidian_reader import TAG_RE, parse_week_plan

LINE = (
    "- [ ] C6: Loopia — verify email — click link "
    "[Open](https://mail.google.com/mail/u/1/#all/19fcd54b24f266c5) ~x46c9c32d3598"
)

WEEK = f"""##### Mon 10
{LINE}
- [ ] B1: real tagging #standards #eu/esi stays a tag
#### Notes
"""


def test_a_url_fragment_survives_the_week_parse():
    task = parse_week_plan(WEEK, "Plan Week.md")["days"][0].tasks[0]
    assert "#all/19fcd54b24f266c5" in task.text


def test_a_real_tag_is_still_a_tag():
    tasks = parse_week_plan(WEEK, "Plan Week.md")["days"][0].tasks
    tagged = tasks[1]
    assert "standards" in tagged.tags
    assert "eu/esi" in tagged.tags
    assert "#standards" not in tagged.clean_text


def test_the_regex_boundary_directly():
    assert TAG_RE.findall("start #tag mid") == ["tag"]
    assert TAG_RE.findall("#leading") == ["leading"]
    assert TAG_RE.findall("https://x.y/u/1/#all/abc") == []
    assert TAG_RE.findall("word#glued") == []
