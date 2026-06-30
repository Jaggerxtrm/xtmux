.PHONY: test test-regen

test:
	./test/contract.sh

test-regen:
	./test/contract.sh --regen
