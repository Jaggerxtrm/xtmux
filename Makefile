.PHONY: test test-regen changelog release

# harness-selftest first: a green contract run proves nothing unless the harness
# under it can actually go red (xtmux-d0a.19).
test:
	./test/harness-selftest.sh
	./test/contract.sh

test-regen:
	./test/contract.sh --regen

# Regenerate CHANGELOG.md from git history via git-cliff. VERSION is optional
# — when set, the pending release is rendered under that tag; without it, new
# rows land under [Unreleased].
#
#   make changelog                    # keep [Unreleased] rolling
#   make changelog VERSION=v0.1.0     # cut the [0.1.0] block for a release
changelog:
	node scripts/changelog.mjs $(if $(VERSION),--tag $(VERSION),) -o CHANGELOG.md

# Cut a release: regenerate CHANGELOG under $(VERSION), commit it, tag, push
# the tag. The release GH Action (see .github/workflows/release.yml) picks up
# the tag push and creates the GitHub release with the [X.Y.Z] section as
# notes. Requires a clean tree on the release branch.
#
#   make release VERSION=v0.1.0
release:
	@[ -n "$(VERSION)" ] || { echo 'usage: make release VERSION=v<MAJOR>.<MINOR>.<PATCH>'; exit 2; }
	@git diff-index --quiet HEAD -- || { echo 'release: tree is dirty, commit or stash first'; exit 2; }
	# Bump package.json/package-lock.json to the same semver; --allow-same-version
	# is a no-op the first time we cut a tag that matches the current version.
	npm version --no-git-tag-version --allow-same-version $(VERSION:v%=%)
	$(MAKE) changelog VERSION=$(VERSION)
	git add CHANGELOG.md package.json package-lock.json
	git commit -m "chore(release): cut $(VERSION)"
	git tag -a $(VERSION) -m "$(VERSION)"
	git push origin HEAD $(VERSION)
