# Repository guidance

- Read IMPLEMENTATION_PROMPT.md before planning or implementing. The user authorizes implementation in this project: plan first, then execute the plan without an extra approval gate for routine development.
- Apply YAGNI, simplicity, minimalism and modularity. Prefer concise ordinary code and one-liners when readable; never sacrifice correctness merely to reduce line count.
- Integrate with ProxyKit's real installed TypeScript/Node extension contract. Do not implement a second proxy or invent host APIs that do not exist.
- Use generic sample labels: Personal usage, Work laptop, Example user. Never commit credentials, private transcripts, account databases or runtime artifacts.
- Keep changes small and reviewable. Test observable behavior and document limitations honestly. Distinguish implemented features, mocks, proposals and real-provider verification.
- The user monitors this thread directly. No reporting or monitoring in an originating thread is requested.
