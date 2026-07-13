.PHONY: test test-regen

# harness-selftest first: a green contract run proves nothing unless the harness
# under it can actually go red (xtmux-d0a.19).
test:
	./test/harness-selftest.sh
	./test/contract.sh

test-regen:
	./test/contract.sh --regen
