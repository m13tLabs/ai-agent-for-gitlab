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
