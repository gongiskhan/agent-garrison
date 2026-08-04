.DEFAULT_GOAL := remote-help

REMOTE_DEV := ./scripts/remote-dev.sh

.PHONY: \
	remote-help \
	remote-doctor \
	remote-plan \
	remote-typecheck \
	remote-test \
	remote-check \
	remote-build \
	remote-preview \
	remote-shell \
	remote-resume \
	remote-prod-status \
	remote-deploy

remote-help:
	@$(REMOTE_DEV) help

remote-doctor:
	@$(REMOTE_DEV) doctor

remote-plan:
	@$(REMOTE_DEV) plan

remote-typecheck:
	@$(REMOTE_DEV) typecheck

remote-test:
	@$(REMOTE_DEV) test

remote-check:
	@$(REMOTE_DEV) check

remote-build:
	@$(REMOTE_DEV) build

remote-preview:
	@$(REMOTE_DEV) preview

remote-shell:
	@$(REMOTE_DEV) shell

remote-resume:
	@test -n "$(CLAUDE_SESSION)" || { \
		echo "usage: make remote-resume CLAUDE_SESSION=<uuid>" >&2; \
		exit 2; \
	}
	@$(REMOTE_DEV) resume "$(CLAUDE_SESSION)" "$(RESUME_CONFIRM)"

remote-prod-status:
	@$(REMOTE_DEV) prod-status

remote-deploy:
	@test -n "$(CONFIRM_DEPLOY)" || { \
		echo "production is disruptive; read docs/REMOTE_MAC_WORKFLOW.md first" >&2; \
		echo "then pass CONFIRM_DEPLOY=deploy-garrison-prod" >&2; \
		exit 2; \
	}
	@$(REMOTE_DEV) deploy "$(CONFIRM_DEPLOY)"
