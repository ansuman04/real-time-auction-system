#!/usr/bin/env python3
import secrets
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'.env'
if p.exists():
    raise SystemExit('Existing .env preserved; not overwriting.')
chars='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
def random_password(n=36):return ''.join(secrets.choice(chars) for _ in range(n))
p.write_text('POSTGRES_PASSWORD='+random_password()+'\nRABBITMQ_PASSWORD='+random_password()+'\nSTRIPE_WEBHOOK_SECRET='+random_password(48)+'\n',encoding='utf-8')
print('Generated local credentials in .env (not displayed). Do not commit this file.')
