{{- define "northstar.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "northstar.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "northstar.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
