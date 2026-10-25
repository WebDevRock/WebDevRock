# deploy.ps1
$ErrorActionPreference = "Stop"

$SSH = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$SCP = "$env:WINDIR\System32\OpenSSH\scp.exe"
$KEY = "$env:USERPROFILE\.ssh\id_rsa"   # change if you use a different key

$DROPLET_USER = "chris"
$DROPLET_HOST = "167.172.53.49"
$REMOTE_ROOT  = "/var/www"
$SITE_DIR     = "$REMOTE_ROOT/webdevrock.uk"
$RELEASE_DIR  = "$REMOTE_ROOT/.webdevrock.uk_release"

& $SSH -i $KEY "$DROPLET_USER@$DROPLET_HOST" "rm -rf $RELEASE_DIR && mkdir -p $RELEASE_DIR"

& $SCP -i $KEY -r ".\dist\*" "$DROPLET_USER@$DROPLET_HOST`:$RELEASE_DIR/"

& $SSH -i $KEY "$DROPLET_USER@$DROPLET_HOST" "rm -rf $SITE_DIR && mv $RELEASE_DIR $SITE_DIR && find $SITE_DIR -type d -exec chmod 755 {} \; && find $SITE_DIR -type f -exec chmod 644 {} \;"

# Tell Bing and the other IndexNow search engines which pages changed (see scripts/indexnow.mjs).
# A failed submission doesn't fail the deploy: run npm run indexnow again later.
node scripts/indexnow.mjs
if ($LASTEXITCODE -ne 0) { Write-Warning "IndexNow submission failed; the deploy itself succeeded." }
