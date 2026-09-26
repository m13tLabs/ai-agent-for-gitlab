
## [0.2.1](https://github.com/m13tLabs/ai-agent-for-gitlab/compare/v0.2.0...v0.2.1) (2026-09-26)

### Documentation

* Adding artifacthub links ([2be789e](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/2be789e9d76fb4d9be01e09b9f25cd31232e25d8))




## [0.2.0](https://github.com/m13tLabs/ai-agent-for-gitlab/compare/v0.1.1...v0.2.0) (2026-09-25)

### Features

* Update stack ([6764524](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/6764524d6a9b10fc20a1afbeb4f66cfb6ca0ac18))

* **Gitlab:** Automate gitlab configuration ([793976d](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/793976d008b2f4d5a8f140357a24e8f4a2769ea7))




## [0.1.1](https://github.com/m13tLabs/ai-agent-for-gitlab/compare/...v0.1.1) (2026-09-25)

### Bug Fixes

* Correct mcp_config_file parameter to mcp_config in issue-triage workflow (#89) ([fb7365f](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/fb7365fba9add22f3986dcb26fede5f7031375b4))

* Update condition for final message in output (#106) ([0cd44e5](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/0cd44e50dd36c4b7357539419f1feb0bb25404ef))

* Specify baseUrl in Octokit (#107) (#108) ([f6e5597](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/f6e559763308297490c3ee55d7753cf969ceafa8))

* Wrap github MCP config with mcpServers in issue-triage workflow (#118) ([bd71ac0](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/bd71ac0e8fce5a1d933d1de0482ccb09274f4984))

* Skip SHA computation for deleted files (#115) ([be799cb](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/be799cbe7b49030e819758e3b0133b6eb9f9e201))

* Only load GitHub MCP server when its tools are allowed (#124) ([699aa26](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/699aa26b4191ac1743a1819c5c724bfdb16e6bee))

* Replace github.action_path with GITHUB_ACTION_PATH for containerized workflows (#133) ([8e8be41](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/8e8be41f1578a3e233d3314a276bf64c87785f90))

* Set disallowed_tools as env when runing prepare.ts (#151) ([37ec8e4](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/37ec8e47813bc9d7755f0f56ce7f7f290941299e))

* Add baseUrl to Octokit initialization in update_claude_comment (#157) ([25f9b8e](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/25f9b8ef9ec0e3c1882b2075a6f1a14bd2458ab7))

* Correct assignee trigger test to handle different assignee properly (#178) ([13ccdab](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/13ccdab2f8b45fde1825caf9a88c1901f38c92c5))

* Allow direct_prompt with issue assignment without requiring assignee_trigger (#192) ([3825490](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/38254908ae505a7fc87cdc8ca3510717b8142803))

* Add missing LABEL_TRIGGER environment variable to prepare step (#209) ([91c510a](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/91c510a769db0f9b79df0efbdded0c29c033f846))

* Resolve CI issues - formatting and TypeScript errors (#217) ([a7665d3](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/a7665d369844457f375050352d7352ee9cad490d))

* **github:** Fixing claude login user name (#227) ([e43c1b7](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/e43c1b7facfb79ed6e0e3f9a70188ecdef3e51a0))

* Update MCP server image to version 0.6.0 (#234) ([6364776](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/6364776f60df0aeb83d4efda5906d68d8cc72137))

* Add GITHUB_API_URL to all Octokit client instantiations (#243) ([0f9a2c4](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/0f9a2c4dc3ab97e8e566ac723330fdb05b888d78))

* Use GITHUB_SERVER_URL to determine email domain for GitHub Enterprise (#290) ([d4d7974](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/d4d7974604c97ec79208ca115b863b41a325d62d))

* Prevent command injection in git hash-object call (#297) ([00b4a23](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/00b4a235512198bb7d7583a67b835024bd528812))

* Add Bedrock base URL fallback to match base-action configuration (#304) ([f6e7adf](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/f6e7adf89ef0a0b369a2b7e69a78bbb7cdb0030c))

* Add model parameter support to base-action (#307) ([de86beb](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/de86beb3aee5187589f6ef3483c72172dd653b68))

* Conditionally show Bash limitation based on commit signing setting (#310) ([d69f61e](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/d69f61e3775f99b8e1078f69225d60283e94b663))

* Run Claude from workflow directory instead of base-action directory (#312) ([d290268](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/d290268f83c4c69c6111ef0b8312c96e79c6b3f4))

* Checkout base branch before creating new branches (#311) ([93df09f](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/93df09fd88688c19bd9e4ca40e5c7281cba39ed1))

* Git checkout disambiguate error (#306) ([51e00de](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/51e00deb0858468e4fb0366955217e9b404596d2))

* Rename Dockerfile.simple to Dockerfile for GitHub Actions workflow ([169ff87](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/169ff8781e16cac54cd566146ff253a12f6605d6))

* Remove Docker Hub and use only GitHub Container Registry ([be85c40](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/be85c40f975c7bb81c783ce3a11de5db4ba10ac9))

* Remove security scan from GitLab app workflow ([dfc3742](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/dfc374279e8d05c897d99a215ddbfe3aaa83bf30))

* Apply prettier formatting to pass CI checks ([c6c0534](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/c6c053430ffbb4b13dc25307ca484961ab92c529))

* Fix GitLab pipeline trigger API variable format ([631377d](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/631377d1ace1bfbdf795e85c45b760cac195d0b8))

* Improve pipeline trigger implementation ([c2d8e7d](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/c2d8e7d3fbf083562e23908eb0cc0726b17e498d))

* Update webhook-triggered GitLab CI to use rules syntax ([b6e78ce](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/b6e78ced50e80925fda35a0855ba46b9bc381299))

* Update webhook-triggered CI to use proper runner script ([c8cbbc6](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/c8cbbc6c40867823130f6e400469af34423da3b8))

* Remove GitHub Actions core.* usage from GitLab mode ([2eb77c1](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/2eb77c1f1f52217ce2d469b3d7c6868522f51cf6))

* Update tests for enhanced GitLab provider debugging ([dd4a078](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/dd4a078ebd531e433839f56fd93ebac6dcc01841))

* Correct GitLab API method calls and fix authentication issues ([8ed173d](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/8ed173dc5ad43299a49e171a35ecbe6686eb8fdf))

* Resolve TypeScript errors in GitLab provider ([d4af8c6](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/d4af8c6fcf94841014af41d85a6754428e8ef71d))

* Handle unexpanded GitLab environment variables and improve token debugging ([2d7d700](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/2d7d7004a26dff20036b2cd03b1b42ebab11773a))

* Fix TypeScript compilation errors ([4dfcb32](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/4dfcb32c358496c0d80be133d51aea31bba30444))

* Improve GitLab prompt generation and add issue context support ([d680488](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/d6804886159b1e15819d8950b3935333380a772b))

* Add missing GitLab webhook module and fix TypeScript errors ([045a29f](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/045a29fe0785815ce25c78d020a2acfcae947d2e))

* Update GitHub Actions workflow for fork compatibility ([3fc2b76](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/3fc2b7655c58f794fe9af2b1bb8a4309dcc30ff5))

* Ensure GitLab comments are posted after Claude execution ([a73193a](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/a73193a368f1e1fb1ff77f8453ea45399dd396c9))

* Remove newlines from GitLab merge request description ([eea0a67](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/eea0a67f57867fa0fb64907dad811e38933c2e95))

* Use CLAUDE_CODE_GL_ACCESS_TOKEN for git push authentication ([22576d3](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/22576d3523fc1a31e6cc5c914d66d56c8867db5a))

* Clean up temp files and properly pass comment ID between processes ([48fa9ae](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/48fa9ae525b24833297771c76053586541eb9352))

* Use file-based communication instead of GitHub-specific ::set-output ([788aecb](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/788aecbfe48937cb2cd67f547d608e8ac88e46fa))



### Documentation

* Update README examples to use 'model' parameter correctly ([d15de3a](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/d15de3a8e38783027765c731ad06b21a6c8f8e2f))

* Add comprehensive FAQ covering common gotchas and limitations (#92) ([8da4781](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/8da47815ec964716298696421c21e1ddf85a3f7b))

* Add uv example for Python MCP servers in mcp_config section (#170) ([def1b3a](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/def1b3a94ee489d17f4959f366dd44e1434da02a))

* Remove references to non-existent test-local.sh script (#187) ([91f620f](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/91f620f8c24a9a3d3dbd1b60a4d67cecc13df0ce))

* Add FAQ entry about assigning in a private repo (#218) ([bcb072b](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/bcb072b63fcbee749b2ac4fbb9f6106681a4b5d9))

* Add custom GitHub App setup instructions (#267) ([c09fc69](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/c09fc691c5fcbf3cc5c4f95c39082636aaf165b7))

* Add missing use_commit_signing input to README (#283) ([bf2400d](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/bf2400d475b6c47e7145968c4d27551410d3d756))

* Add instructions for Docker image visibility and local builds ([2d6366e](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/2d6366e13bcf295577917e12c73f4285c1bd6d36))

* Add documentation for unified GitLab entrypoint ([761e466](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/761e466c6293b46fc32ed8165a446190f06b4a49))

* Add GitLab MR creation and response posting documentation ([7f754fc](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/7f754fcd924ecd91bc7fee682428689f26559941))

* Fix GitLab Quick Start section to show steps instead of options ([03943f6](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/03943f674b514b556c77d5474662974ad0af694f))



### Features

* Strip HTML comments from GitHub content ([dd5e8c9](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/dd5e8c974a997f7800a61d19ed6773e0f368b374))

* Rename anthropic_model input to model with backward compatibility ([9e23f6d](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/9e23f6d9edee0708524d95cebf59dade71d50acc))

* Allow user override of hardcoded disallowed tools (#71) ([37c3c29](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/37c3c29341a34987db13d9bdce44a8fa1a442e4f))

* Display detailed error messages when prepare step fails (#82) ([52efa5e](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/52efa5e498aaed954a436f12fad256d8f8a02903))

* Add base_branch input to specify source branch for new Claude branches (#72) ([fcbdac9](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/fcbdac91f2b781fd1fcd0a56205f53640797e11d))

* Add mcp_config input that merges with existing mcp server (#96) ([e409c57](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/e409c57d904a98dd5e69d686a75629d749d8cf13))

* Add unified update_claude_comment tool (#98) ([1d4d6c4](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/1d4d6c4b93f4ca8a7beb52af8bb1034add5353d0))

* Add claude_env input for custom environment variables (#102) ([70245e5](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/70245e56e330657c561c4315cc1d275d88b8546d))

* Add max_turns parameter support (#149) ([37483ba](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/37483ba1128de6e5b33da71cff57ee65c25a4372))

* Add roadmap for Claude Code GitHub Action v1.0 (#150) ([e5b1633](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/e5b16332494238ba09af60903ea07bbb918db843))

* Add MultiEdit to base_allowed_tools (#155) ([3bcfbe7](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/3bcfbe73859ddf55e4cb2cda805ba8582b5b2237))

* Use GitHub display name in Co-authored-by trailers (#163) ([41dd0aa](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/41dd0aa695a06b94f18ce26fd851bfd6ed9d8760))

* Use dynamic fetch depth based on PR commit count (#169) ([a8d323a](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/a8d323af27aca1f570b0af8115114dcdf052932a))

* Add release workflow with beta tag management (#171) ([ffb2927](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/ffb2927088ee8d2e3fab39463c9742d64c4ebefc))

* Enhance error reporting with specific error types from Claude execution (#164) ([1b94b9e](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/1b94b9e5a85d066d540e74f2b5f616919a874336))

* **config:** Add branch prefix configuration (#197) ([032008d](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/032008d3b67d103140dcee48c0ae48d0d3568719))

* Add `sticky_comment` input to reduce GitHub comment spam (#211) ([79f2086](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/79f2086fce9651dae79e20dfd7bf12f525812f2e))

* Add formatted output for Claude Code execution reports (#18) ([8fe405c](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/8fe405c45f1b154c4848abab0c144ea635dec81f))

* Add fallback_model input to enable automatic model fallback (#228) ([55b7205](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/55b7205cd2488701b60dded79604e04cd4c59cf3))

* Forward NODE_VERSION environment variable to base action (#230) ([86665d0](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/86665d0984fd49d450080db71c55f8aafcf060c2))

* Add OAuth token authentication support (#236) ([a804c9e](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/a804c9e83f1c7a3288cc7a7bbca208491a4bb2f8))

* Add use_commit_signing input with default false (#238) ([87facd7](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/87facd7051952ac2f27354dfadb90dc91e9ebc76))

* Defer remote branch creation until first commit (#244) ([cefe963](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/cefe963a6b4ae0e511c59b9d6cb6b7b5923714a1))

* Add settings input support (#276) ([a9d9ad3](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/a9d9ad3612d6d61922fb1af719a32b9f1366f3f2))

* Integrate claude-code-base-action as local subaction (#285) ([8335bda](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/8335bda2435c52aacc353fc7ec9c1568c498d1b2))

* Add workflow to sync base-action to claude-code-base-action repo (#299) ([dfa92d6](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/dfa92d695228cdc22697d203b91e4104e7e84ae8))

* Update sync workflow to use MIRROR_DISCLAIMER.md file (#300) ([d1e03ad](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/d1e03ad18e564025979ec6891ad333315b8671c1))

* Clarify direct prompt instructions in create-prompt (#324) ([0d204a6](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/0d204a659945e889be1b5a7d7f9e9ea83515a682))

* Integrate Claude Code SDK to replace process spawning (#327) ([204266c](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/204266ca456d17f07482e2f9fa78d2d5d9039a17))

* Add DETAILED_PERMISSION_MESSAGES env var to Claude Code invocation (#328) ([0763498](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/0763498a5a7dd1778edfb255374e71ce88d91d6b))

* Format PR and issue body text in prompt variables (#330) ([9cf75f7](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/9cf75f75b9d954f16b5fd70f7bd58ebcbc667e6a))

* Use Bun as package manager in webhook-service Dockerfile ([9a776c7](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/9a776c7676df9aef9e2b6648edc1c70d995c0ee2))

* Complete GitLab OAuth app with Claude integration ([1ed0265](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/1ed02655910d964f3d2c4819ca8e0ef522e77c32))

* Add GitHub Actions workflow for GitLab app Docker builds ([b895300](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/b895300094c539942a88d0fc8371c7164f94d733))

* Complete React + Express modernization ([1df9f37](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/1df9f37a5e504cbeff59fafcf777986eaccb74ea))

* Add issue branch creation and structured logging ([cc63d52](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/cc63d52d2b45d315a3143d7b606152cb3014298e))

* Add GitLab CI pipeline integration for Claude ([ff28c85](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/ff28c85a75b72f6af934622f034d7ee959fb46c6))

* Improve pipeline trigger error handling with detailed logging ([4c7b985](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/4c7b985a3d8d84c2c3b076d23a131a2f3a1e8596))

* Add CLAUDE_CODE_GL_ACCESS_TOKEN and CC_SKIP_PRE_CHECK support ([c43488d](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/c43488d116e102d4823ac3b4baf1cb17541a2f0a))

* Update webhook-triggered.gitlab-ci.yml with advanced examples and fix tests ([a517412](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/a517412e1b0857cd1ffea269d9b0cbb131c04af6))

* Add Discord notifications and fix GitLab webhook payload ([76bc876](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/76bc876bf17b15ec5dcb21feea592e01f9eea948))

* Add full issue support to GitLab provider ([62eacfc](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/62eacfc97597a70d4096f9cfa2e7a82605930bb9))

* Add comprehensive logging for GitLab authentication debugging ([6c58f80](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/6c58f80aca8c3210244f4ea82645532c1f0bfa6c))

* Add complete Claude Code execution to GitLab CI ([980d580](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/980d58057f1058fe9b719df442f99e45316049b5))

* Add unified GitLab entrypoint for simplified CI workflow ([130bc6e](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/130bc6e9dc7f3258b853bcaafb3b9f1a383377a3))

* Add centralized temp directory handling for GitHub and GitLab ([f43ba69](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/f43ba695d35cc338ddd58fc92a3a007af5f7004e))

* Add GitLab merge request creation and response posting ([8765274](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/876527443c292ef34f097a3ea102e06fa37129b6))

* Add GitLab MR creation, fix webhook branch handling, emphasize GitLab-only nature ([9cd733a](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/9cd733aee6d8beb0969cadcb410443a6cf637fbe))

* **Deployment:** Adding helm chart ([56fa51a](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/56fa51aa4c2b70a36c92ccbc7b52f16b764b6d41))

* **Docker:** Rename images and apply OCI best practises ([6f50f9c](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/6f50f9c843255bd0ccd9754fc32c7aa25afb5916))



### Performance

* Optimize Squid proxy startup time (#334) ([963754f](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/963754fa12b38d17c5a7b5068b764e8b0cd9ff73))



### Refactoring

* Update branch naming convention for Kubernetes compatibility (#249) ([b92e56a](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/b92e56a96bb2fce337ece11f6dcb03bab4826536))

* Clarify git command availability and remove user config instruction (#322) ([c96a923](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/c96a923d95df2bd0b5377578a23afb7b1abee443))

* Replace manual GitLab API calls with Gitbeaker SDK ([8c4a031](https://github.com/m13tLabs/ai-agent-for-gitlab/commit/8c4a03147f7980da7cd46e2be72db4972a8bf0e1))



