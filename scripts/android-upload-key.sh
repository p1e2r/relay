#!/usr/bin/env bash
# Creates the Play Store upload key and prints the GitHub secrets to add.
# Keep the .jks file and passwords safe and OUT of git; losing them means asking Google for an upload-key reset.
set -euo pipefail
cd "$(dirname "$0")/../client/android"
KEYSTORE="${KEYSTORE:-relay-upload.jks}"
ALIAS="${ALIAS:-relay}"
read -rsp "Choose a keystore password (min 6 chars): " PASS; echo
keytool -genkeypair -v -keystore "$KEYSTORE" -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" -dname "CN=Relay, O=p1e2r"
cat > keystore.properties <<PROPS
storeFile=../$KEYSTORE
storePassword=$PASS
keyAlias=$ALIAS
keyPassword=$PASS
PROPS
echo
echo "Created client/android/$KEYSTORE and keystore.properties (both git-ignored)."
echo "For CI, add these repository secrets (Settings > Secrets and variables > Actions):"
echo "  ANDROID_KEYSTORE_BASE64 = $(base64 < "$KEYSTORE" | tr -d '\n' | head -c 20)...  (run: base64 -i client/android/$KEYSTORE | pbcopy)"
echo "  ANDROID_KEYSTORE_PASSWORD = <your password>"
echo "  ANDROID_KEY_ALIAS = $ALIAS"
