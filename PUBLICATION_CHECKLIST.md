# Before making this repository public
- [ ] Verify rights to redistribute source from the course/workshop; preserve appropriate attribution
- [ ] Review every file and remove workshop-only material and personally identifying traces
- [ ] Run `python scripts/configure.py` then `npm ci`
- [ ] Run Docker Compose and migrations from a clean state, then the app and tests
- [ ] Run TypeScript typechecks and frontend build
- [ ] Run `gitleaks dir --redact .` and `gitleaks git --redact`
- [ ] Review security/dependency advisories, application authentication and deployment assumptions
- [ ] Create a new EMPTY **private** GitHub repository; publish as private first
- [ ] Decide on public visibility only after the above checks pass
