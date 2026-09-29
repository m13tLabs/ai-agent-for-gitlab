{{- define "ai-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ai-agent.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "ai-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ai-agent.labels" -}}
helm.sh/chart: {{ include "ai-agent.chart" . }}
{{ include "ai-agent.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "ai-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: webhook
{{- end }}

{{- define "ai-agent.redisSelectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: redis
{{- end }}

{{/* Labels for the gitlabSetup Job/CronJob and its RBAC (component: gitlab-setup). */}}
{{- define "ai-agent.setupLabels" -}}
helm.sh/chart: {{ include "ai-agent.chart" . }}
{{ include "ai-agent.setupSelectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "ai-agent.setupSelectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: gitlab-setup
{{- end }}

{{- define "ai-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ai-agent.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "ai-agent.secretName" -}}
{{- default (include "ai-agent.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{/*
secretKeyRef body (name + key) for one token, called with (list $ "<token>")
where <token> is gitlabToken, webhookSecret, adminToken or gitlabAdminToken.
secrets.secretKeyRefs.<token>.name wins (key defaults to secrets.keys.<token>);
otherwise existingSecret or the chart Secret with secrets.keys.<token>.
*/}}
{{- define "ai-agent.secretKeyRef" -}}
{{- $root := index . 0 }}
{{- $token := index . 1 }}
{{- $key := index $root.Values.secrets.keys $token }}
{{- $refs := $root.Values.secrets.secretKeyRefs | default dict }}
{{- $refName := dig $token "name" "" $refs }}
{{- if $refName -}}
name: {{ $refName | quote }}
key: {{ dig $token "key" "" $refs | default $key | quote }}
{{- else -}}
name: {{ include "ai-agent.secretName" $root | quote }}
key: {{ $key | quote }}
{{- end }}
{{- end }}

{{/*
Agent image forwarded as AI_AGENT_IMAGE: "<repository>:<tag>", or "" when
repository is empty. A plain string (the pre-split form of agentImage) is
passed through unchanged.
*/}}
{{- define "ai-agent.agentImage" -}}
{{- $img := .Values.agentImage }}
{{- if kindIs "string" $img }}
{{- $img }}
{{- else if $img.repository }}
{{- printf "%s:%s" $img.repository ($img.tag | default .Chart.AppVersion) }}
{{- end }}
{{- end }}

{{/*
Trigger phrase (TRIGGER_PHRASE): agent.triggerPhrase when set, otherwise
@<gitlab.aiUsername> when gitlabSetup creates that account, else @ai.
*/}}
{{- define "ai-agent.triggerPhrase" -}}
{{- if .Values.agent.triggerPhrase }}
{{- .Values.agent.triggerPhrase }}
{{- else if .Values.gitlabSetup.enabled }}
{{- printf "@%s" (required "gitlab.aiUsername is required" .Values.gitlab.aiUsername) }}
{{- else }}
{{- "@ai" }}
{{- end }}
{{- end }}

{{/*
Runner project (AI_RUNNER_PROJECT): agent.runnerProject when set, otherwise
the one gitlabSetup.centralPipeline creates, else "" (each project's own pipeline).
*/}}
{{- define "ai-agent.runnerProject" -}}
{{- if .Values.agent.runnerProject }}
{{- .Values.agent.runnerProject }}
{{- else if and .Values.gitlabSetup.enabled .Values.gitlabSetup.centralPipeline.enabled }}
{{- .Values.gitlabSetup.centralPipeline.runner.project }}
{{- end }}
{{- end }}

{{/*
additionalEnvs as env entries, for the webhook and gitlabSetup containers.
Takes a map ({HTTPS_PROXY: ...}) or a list of maps ([{HTTPS_PROXY: ...}]).
With a proxy variable set, Node's fetch only uses it with NODE_USE_ENV_PROXY=1,
and the Kubernetes API (reached by IP, NO_PROXY takes no CIDRs) is added to
NO_PROXY through the kubelet's $(VAR) expansion of the service variables.
*/}}
{{- define "ai-agent.additionalEnvs" -}}
{{- $in := .Values.additionalEnvs | default list }}
{{- $maps := kindIs "map" $in | ternary (list $in) $in }}
{{- $pairs := list }}
{{- $names := dict }}
{{- range $maps }}
{{- range $name, $value := . }}
{{- $pairs = append $pairs (dict "name" $name "value" (toString $value)) }}
{{- $_ := set $names $name true }}
{{- end }}
{{- end }}
{{- $proxy := or (hasKey $names "HTTPS_PROXY") (hasKey $names "https_proxy") (hasKey $names "HTTP_PROXY") (hasKey $names "http_proxy") }}
{{- $noProxy := ternary "no_proxy" "NO_PROXY" (and (hasKey $names "no_proxy") (not (hasKey $names "NO_PROXY"))) }}
{{- range $pairs }}
- name: {{ .name }}
  {{- if and $proxy (eq .name $noProxy) }}
  value: {{ printf "%s,$(KUBERNETES_SERVICE_HOST)" .value | quote }}
  {{- else }}
  value: {{ .value | quote }}
  {{- end }}
{{- end }}
{{- if $proxy }}
{{- if not (hasKey $names "NODE_USE_ENV_PROXY") }}
- name: NODE_USE_ENV_PROXY
  value: "1"
{{- end }}
{{- if not (hasKey $names $noProxy) }}
- name: NO_PROXY
  value: "$(KUBERNETES_SERVICE_HOST)"
{{- end }}
{{- end }}
{{- end }}

{{- define "ai-agent.redisEnabled" -}}
{{- if and .Values.rateLimiting.enabled .Values.redis.enabled }}true{{- end }}
{{- end }}

{{- define "ai-agent.redisUrl" -}}
{{- if include "ai-agent.redisEnabled" . }}
{{- printf "redis://%s-redis:6379" (include "ai-agent.fullname" .) }}
{{- else }}
{{- .Values.redis.externalUrl }}
{{- end }}
{{- end }}

{{/* Secret holding the bot token that the gitlabSetup Job creates and rotates. */}}
{{- define "ai-agent.botTokenSecretName" -}}
{{- printf "%s-bot-token" (include "ai-agent.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ai-agent.setupName" -}}
{{- printf "%s-setup" (include "ai-agent.fullname" .) | trunc 52 | trimSuffix "-" }}
{{- end }}

{{/* URL the GitLab system hook posts to: explicit, or the in-cluster Service. */}}
{{- define "ai-agent.systemHookUrl" -}}
{{- if .Values.gitlabSetup.systemHook.url }}
{{- .Values.gitlabSetup.systemHook.url }}
{{- else }}
{{- printf "http://%s.%s.svc.cluster.local:%v/webhook" (include "ai-agent.fullname" .) .Release.Namespace .Values.service.port }}
{{- end }}
{{- end }}

{{/*
Checksum of the values the setup and the webhook pods depend on. The setup
restarts the Deployment when it differs from the one the pods last ran with.
*/}}
{{- define "ai-agent.setupConfigChecksum" -}}
{{- dict "gitlab" .Values.gitlab "secrets" .Values.secrets | toJson | sha256sum }}
{{- end }}

{{/* Pod spec shared by the gitlabSetup Job and CronJob (runs src/setup.ts). */}}
{{- define "ai-agent.setupPodSpec" -}}
{{- $setup := .Values.gitlabSetup -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
serviceAccountName: {{ include "ai-agent.setupName" . }}
# Needs the token to write the bot-token Secret and restart the Deployment.
automountServiceAccountToken: true
restartPolicy: Never
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
containers:
  - name: gitlab-setup
    image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    command: ["node", "src/setup.ts"]
    securityContext:
      {{- toYaml .Values.securityContext | nindent 6 }}
    env:
      - name: GITLAB_URL
        value: {{ .Values.gitlab.url | quote }}
      - name: GITLAB_ADMIN_TOKEN
        valueFrom:
          secretKeyRef:
            {{- include "ai-agent.secretKeyRef" (list . "gitlabAdminToken") | nindent 12 }}
      - name: AI_GITLAB_USERNAME
        value: {{ required "gitlab.aiUsername is required" .Values.gitlab.aiUsername | quote }}
      - name: AI_GITLAB_EMAIL
        value: {{ .Values.gitlab.aiEmail | quote }}
      - name: BOT_NAME
        value: {{ $setup.botName | quote }}
      - name: BOT_ACCOUNT_TYPE
        value: {{ $setup.accountType | quote }}
      - name: BOT_ACCESS_LEVEL
        value: {{ $setup.accessLevel | toString | quote }}
      - name: SETUP_GROUPS
        value: {{ $setup.groups | default list | toJson | quote }}
      - name: SETUP_PROJECTS
        value: {{ $setup.projects | default list | toJson | quote }}
      {{- if $setup.avatar }}
      - name: BOT_AVATAR_PATH
        value: /avatar/bot-avatar.png
      {{- end }}
      - name: SYSTEM_HOOK_ENABLED
        value: {{ $setup.systemHook.enabled | toString | quote }}
      {{- /* Hook target, shared by the system hook and the project webhooks. */}}
      {{- if or $setup.systemHook.enabled $setup.projects }}
      - name: SYSTEM_HOOK_URL
        value: {{ include "ai-agent.systemHookUrl" . | quote }}
      - name: SYSTEM_HOOK_SSL_VERIFICATION
        value: {{ $setup.systemHook.sslVerification | toString | quote }}
      - name: WEBHOOK_SECRET
        valueFrom:
          secretKeyRef:
            {{- include "ai-agent.secretKeyRef" (list . "webhookSecret") | nindent 12 }}
      {{- end }}
      - name: BOT_TOKEN_SECRET
        value: {{ include "ai-agent.botTokenSecretName" . }}
      - name: BOT_TOKEN_EXPIRY_DAYS
        value: {{ $setup.token.expiryDays | toString | quote }}
      - name: BOT_TOKEN_RENEW_BEFORE_DAYS
        value: {{ $setup.token.renewBeforeDays | toString | quote }}
      - name: RESTART_DEPLOYMENT
        value: {{ include "ai-agent.fullname" . }}
      {{- with $setup.centralPipeline }}
      {{- if .enabled }}
      - name: CENTRAL_PIPELINE_ENABLED
        value: "true"
      - name: CENTRAL_PIPELINE_VISIBILITY
        value: {{ .visibility | quote }}
      - name: COMPONENT_PROJECT
        value: {{ required "gitlabSetup.centralPipeline.component.project is required" .component.project | quote }}
      - name: COMPONENT_CLONE_URL
        value: {{ required "gitlabSetup.centralPipeline.component.cloneUrl is required" .component.cloneUrl | quote }}
      - name: COMPONENT_MIRROR
        value: {{ .component.mirror | toString | quote }}
      - name: COMPONENT_REF
        value: {{ .component.ref | default (printf "v%s" $.Chart.AppVersion) | quote }}
      - name: RUNNER_PROJECT
        value: {{ required "gitlabSetup.centralPipeline.runner.project is required" .runner.project | quote }}
      - name: RUNNER_COMPONENT_INPUTS
        value: {{ .runner.inputs | default dict | toJson | quote }}
      - name: RUNNER_EXTRA_INCLUDES
        value: {{ .runner.extraIncludes | default list | toJson | quote }}
      {{- with .runner.extraConfig }}
      - name: RUNNER_EXTRA_CONFIG
        value: {{ kindIs "string" . | ternary . (toYaml .) | quote }}
      {{- end }}
      {{- end }}
      {{- end }}
      - name: CONFIG_CHECKSUM
        value: {{ include "ai-agent.setupConfigChecksum" . | quote }}
      # Lets fetch() trust the in-cluster API server certificate.
      - name: NODE_EXTRA_CA_CERTS
        value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      - name: HOME
        value: /tmp
      - name: LOG_LEVEL
        value: {{ .Values.logging.level | quote }}
      - name: LOG_FORMAT
        value: {{ .Values.logging.format | quote }}
      {{- with include "ai-agent.additionalEnvs" . }}
      {{- . | nindent 6 }}
      {{- end }}
    resources:
      {{- toYaml $setup.resources | nindent 6 }}
    volumeMounts:
      - name: tmp
        mountPath: /tmp
      {{- if $setup.avatar }}
      - name: avatar
        mountPath: /avatar
        readOnly: true
      {{- end }}
volumes:
  - name: tmp
    emptyDir: {}
  {{- if $setup.avatar }}
  - name: avatar
    configMap:
      name: {{ include "ai-agent.setupName" . }}-avatar
  {{- end }}
{{- end }}
