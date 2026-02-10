#!/usr/bin/env bash
set -euo pipefail

STAGE="${STAGE:-prod}"
REGION="${AWS_REGION:-eu-west-1}"
STACK_NAME="bg-remover-${STAGE}"

echo "🔐 Attaching code signing config for stack: ${STACK_NAME} (${REGION})"

CODE_SIGNING_ARN="$(aws cloudformation list-stack-resources \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "StackResourceSummaries[?LogicalResourceId=='CodeSigningConfig'].PhysicalResourceId" \
  --output text)"

if [[ -z "${CODE_SIGNING_ARN}" ]]; then
  echo "❌ CodeSigningConfig not found in stack ${STACK_NAME}"
  exit 1
fi

echo "✅ CodeSigningConfig ARN: ${CODE_SIGNING_ARN}"

FUNCTIONS="$(aws lambda list-functions \
  --region "${REGION}" \
  --query "Functions[?starts_with(FunctionName, 'bg-remover-${STAGE}-')].FunctionName" \
  --output text)"

if [[ -z "${FUNCTIONS}" ]]; then
  echo "❌ No bg-remover functions found for stage ${STAGE}"
  exit 1
fi

for fn in ${FUNCTIONS}; do
  echo "→ Applying code signing to ${fn}"
  aws lambda put-function-code-signing-config \
    --region "${REGION}" \
    --function-name "${fn}" \
    --code-signing-config-arn "${CODE_SIGNING_ARN}" >/dev/null
done

echo "✅ Code signing applied to bg-remover-${STAGE} functions."
