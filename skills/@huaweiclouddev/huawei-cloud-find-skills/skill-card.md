## Description: <br>

Helps agents search, browse, view details for, and install Huawei Cloud agent skills. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>

[huaweiclouddev](https://clawhub.ai/user/huaweiclouddev) <br>

### License/Terms of Use: <br>

MIT-0 <br>

## Use Case: <br>

Developers and cloud operators use this skill to discover Huawei Cloud agent skills by keyword or category, inspect candidate skill details, and install a selected skill for a management task. <br>

### Deployment Geography for Use: <br>

Global <br>

## Known Risks and Mitigations: <br>

Risk: Installing a matched skill can add remote code-backed instructions to the local agent environment. <br>
Mitigation: Confirm the exact skill name and source repository before running an install command, then review the installed skill before using it. <br>

## Reference(s): <br>

- [ClawHub skill page](https://clawhub.ai/huaweiclouddev/skills/huawei-cloud-find-skills) <br>
- [Huawei Cloud skills repository](https://github.com/huaweicloud/huaweicloud-skills) <br>
- [GitCode skill index API](https://gitcode.com/api/v5/repos/2501_91318609/skills-for-index/contents/skills-index/index.json?ref=main) <br>
- [GitCode Chinese-English map API](https://gitcode.com/api/v5/repos/2501_91318609/skills-for-index/contents/skills-index/cn-en-map.json?ref=main) <br>
- [Local search script](scripts/search-skills.py) <br>

## Skill Output: <br>

**Output Type(s):** [Text, Markdown, Shell commands, Guidance] <br>
**Output Format:** [Markdown guidance with command examples and script output] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May include network-fetched search results and install commands for a selected skill.] <br>

## Skill Version(s): <br>

1.0.0 (source: server-resolved release metadata) <br>

## Ethical Considerations: <br>

Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
