{{/*
Generate a full name for the resources, optionally including the release name.
*/}}
{{- define "seda-data-proxy.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{/*
Common labels
*/}}
{{- define "seda-data-proxy.labels" -}}
app.kubernetes.io/name: {{ include "seda-data-proxy.name" . }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "seda-data-proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "seda-data-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Template for the name of the application
*/}}
{{- define "seda-data-proxy.name" -}}
{{- .Chart.Name -}}
{{- end }}
