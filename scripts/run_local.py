#!/usr/bin/env python3
import os,subprocess,sys
from pathlib import Path
from urllib.parse import quote
root=Path(__file__).resolve().parents[1]
def read_env(p):
    d={}
    for line in p.read_text(encoding="utf-8").splitlines():
        line=line.strip()
        if not line or line.startswith("#") or "=" not in line:continue
        k,v=line.split("=",1)
        d[k.strip()]=v.strip().strip('"').strip("'")
    return d
p=root/'.env'
if not p.exists():
    print('No .env found. Run: python scripts/configure.py',file=sys.stderr)
    sys.exit(2)
settings=read_env(p)
required=['POSTGRES_PASSWORD','RABBITMQ_PASSWORD','STRIPE_WEBHOOK_SECRET']
missing=[k for k in required if not settings.get(k)]
if missing:
    print('Missing settings: '+', '.join(missing),file=sys.stderr)
    sys.exit(2)
env=os.environ.copy();env.update(settings)
env['DATABASE_URL']='postgres://auction:'+quote(settings['POSTGRES_PASSWORD'],safe='')+'@localhost:55448/auction_part_8'
env['RABBITMQ_URL']='amqp://auction:'+quote(settings['RABBITMQ_PASSWORD'],safe='')+'@localhost:56738/auction_part_8'
env['REDIS_URL']='redis://127.0.0.1:56398'
env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']='http://127.0.0.1:4338/v1/traces'
# Portfolio application ports
env['API_PORT'] = '3118'
env['WEB_PORT'] = '5118'
env['STRIPE_PORT'] = '7118'
# Service-to-service communication
env['STRIPE_URL'] = 'http://127.0.0.1:7118'
env['CHECKOUT_WEB_URL'] = 'http://localhost:5118'
env['AUCTION_WEBHOOK_URL'] = 'http://127.0.0.1:3118/api/webhooks/stripe'
# Frontend Socket.IO access
env['WEB_ORIGINS'] = 'http://localhost:5118,http://127.0.0.1:5118'
env.setdefault('CLOSE_WORKER_POLL_MS','1000');env.setdefault('CLOSE_WORKER_BATCH_SIZE','100')
if len(sys.argv)<2:
    print('Usage: python scripts/run_local.py <npm-script>',file=sys.stderr);sys.exit(2)
name=sys.argv[1]
# 'npm.cmd' on Windows, 'npm' elsewhere.
npm='npm.cmd' if os.name=='nt' else 'npm'
sys.exit(subprocess.call([npm,'run','_portfolio:'+name,'--',*sys.argv[2:]],cwd=root,env=env))
