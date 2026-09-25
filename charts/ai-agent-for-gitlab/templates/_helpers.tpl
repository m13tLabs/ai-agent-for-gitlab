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
{{- printf "%s-gitlab-setup" (include "ai-agent.fullname" .) | trunc 52 | trimSuffix "-" }}
{{- end }}

{{/* URL the GitLab system hook posts to: explicit, or the in-cluster Service. */}}
{{- define "ai-agent.systemHookUrl" -}}
{{- if .Values.gitlabSetup.systemHook.url }}
{{- .Values.gitlabSetup.systemHook.url }}
{{- else }}
{{- printf "http://%s.%s.svc.cluster.local:%v/webhook" (include "ai-agent.fullname" .) .Release.Namespace .Values.service.port }}
{{- end }}
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
            name: {{ include "ai-agent.secretName" . }}
            key: {{ .Values.secrets.keys.gitlabAdminToken }}
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
        value: {{ join "," $setup.groups | quote }}
      {{- if $setup.avatar }}
      - name: BOT_AVATAR_PATH
        value: /avatar/bot-avatar.png
      {{- end }}
      - name: SYSTEM_HOOK_ENABLED
        value: {{ $setup.systemHook.enabled | toString | quote }}
      {{- if $setup.systemHook.enabled }}
      - name: SYSTEM_HOOK_URL
        value: {{ include "ai-agent.systemHookUrl" . | quote }}
      - name: SYSTEM_HOOK_SSL_VERIFICATION
        value: {{ $setup.systemHook.sslVerification | toString | quote }}
      - name: WEBHOOK_SECRET
        valueFrom:
          secretKeyRef:
            name: {{ include "ai-agent.secretName" . }}
            key: {{ .Values.secrets.keys.webhookSecret }}
      {{- end }}
      - name: BOT_TOKEN_SECRET
        value: {{ include "ai-agent.botTokenSecretName" . }}
      - name: BOT_TOKEN_EXPIRY_DAYS
        value: {{ $setup.token.expiryDays | toString | quote }}
      - name: BOT_TOKEN_RENEW_BEFORE_DAYS
        value: {{ $setup.token.renewBeforeDays | toString | quote }}
      - name: RESTART_DEPLOYMENT
        value: {{ include "ai-agent.fullname" . }}
      # Lets fetch() trust the in-cluster API server certificate.
      - name: NODE_EXTRA_CA_CERTS
        value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      - name: HOME
        value: /tmp
      - name: LOG_LEVEL
        value: {{ .Values.logging.level | quote }}
      - name: LOG_FORMAT
        value: {{ .Values.logging.format | quote }}
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
