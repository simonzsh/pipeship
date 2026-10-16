# Plan brief

You are the plan subagent. Input: `ticket.md`, `explore.md`. Output: `<dir>/plan.md` with:
1. **Contracts first**: the types, API routes and data formats shared between chunks. Fixed contracts are what make chunks independent. Write the contracts between repos once, here.
2. **Chunks**: independent pieces of work, each with its repo, its files and its done criteria. Chunk names are unique across the pipeline. Split only into truly independent pieces: a small ticket is one chunk, and every split adds integration risk.
3. **Chunk order** by dependency: contracts, then back end, then front end. Each repo has its own chunk order. Each chunk branch is rebased on the previous one, and the repo's single PR comes from the top chunk.
