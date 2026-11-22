"""Targeted schema smoke checks, NOT full OpenAPI 3.0 conformance or HTTP tests.
Run: python tests/check-api-fixtures.py (requires PyYAML and jsonschema).
The OpenAPI-aware validation lives in tests/unit/openapi.test.ts (npm run verify:openapi).
"""
from pathlib import Path
import copy
import yaml
from jsonschema import Draft7Validator, FormatChecker
from jsonschema.exceptions import ValidationError

root = Path(__file__).resolve().parents[1]
api = yaml.safe_load((root / 'docs/openapi.draft.yaml').read_text())
schemas = api['components']['schemas']

def normalize(value):
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if not isinstance(value, dict):
        return value
    out = {k: normalize(v) for k, v in value.items() if k != 'nullable'}
    if value.get('nullable') is True and isinstance(value.get('type'), str):
        out['type'] = [value['type'], 'null']
    return out

def check(name, data, valid=True):
    # For these simple draft fixture shapes only, translate nullable to JSON Schema.
    validator = Draft7Validator({'$ref':'#/components/schemas/'+name,
        'components':{'schemas':normalize(schemas)}}, format_checker=FormatChecker())
    try:
        validator.validate(data)
    except ValidationError:
        if valid:
            raise
    else:
        assert valid, f'{name}: rejected fixture unexpectedly accepted'

u = '8b8b8b8b-1111-4111-8111-111111111111'
t = '2026-11-20T12:30:00.000Z'
clock = dict(id=u,kind='RESPONSE',cycle=0,state='RUNNING',cycleStartedAt=t,budgetMs=7200000,consumedMs=0,remainingMs=7200000,deadlineAt=t,completedAt=None,cancelledAt=None,currentLate=False,firstBreachedAt=None,breachDetectedNotRecorded=False,asOf=t,breachSequence=0,policyRevision=0)
base = dict(id=u,subject='Synthetic fixture',status='OPEN',priority='MEDIUM',requestedPriority=None,customerId=u,assigneeId=None,assigneeDisplayName=None,createdAt=t,updatedAt=t,parentTicketId=None,version=0,resolutionCycle=0,waitingCloseDueAt=None,reopenUntil=None,closeReason=None,clocks=[clock])
for schema in ('StaffTicketSummary','StaffTicket'):
    data = dict(base, **({'messages':[],'olderMessagesCursor':None} if schema=='StaffTicket' else {}))
    check(schema,data)
    check(schema,dict(data,status='IN_PROGRESS',assigneeId=u,assigneeDisplayName='Synthetic Agent',requestedPriority='URGENT'))
    check(schema,dict(data,status='CLOSED',closeReason='AUTO_CLOSED_NO_REPLY',assigneeId=u,assigneeDisplayName='Synthetic Agent',clocks=[dict(clock,state='CANCELLED',deadlineAt=None,cancelledAt=t)]))
    check(schema,dict(data,requestedPriority='INVALID'),False)
    check(schema,dict(data,closeReason='INVALID'),False)
error=dict(code='CLAIM_CONFLICT',message='Conflict',requestId='fixture')
check('Error',error)
check('Error',dict(error,assignedAgentDisplayName='Synthetic Agent'),False)
check('StaffClaimConflict',dict(error,assignedAgentDisplayName='Synthetic Agent'))
claim=api['paths']['/tickets/{id}/claim']['post']['responses']['409']['content']['application/json']['schema']['$ref']
assert claim.endswith('/StaffClaimConflict')
for path,ops in api['paths'].items():
    if path.startswith('/customer/'):
        assert 'StaffClaimConflict' not in str(ops)
# The action-specific union must reject unknown detail fields and mismatched shapes.
event=dict(id=u,ticketId=u,actorId=u,actorType='AGENT',action='MESSAGE_PUBLISHED',createdAt=t,correlationId='fixture',reasonCode=None,details=dict(beforeVersion=0,afterVersion=1,messageId=u,messageKind='REPLY',publishedAt=t))
check('AuditEvent', event)
check('AuditEvent',dict(event,details=dict(event['details'],body='secret')),False)
check('AuditEvent',dict(event,action='PRIORITY_CHANGED'),False)
check('AuditEvent',dict(event,action='UNKNOWN'),False)
refs=[]
def walk(v):
    if isinstance(v,dict):
        if '$ref' in v: refs.append(v['$ref'])
        for k in v.values(): walk(k)
    elif isinstance(v,list):
        for k in v: walk(k)
walk(api)
for r in refs:
    assert r.startswith('#/')
    node=api
    for k in r[2:].split('/'):
        node=node[k.replace('~1','/').replace('~0','~')]
print(f'Targeted fixtures passed (nullable ticket fields, invalid enum rejection, restricted claim error, typed audit action and secret rejection); {len(refs)} local references resolved; {len(api["paths"])} paths; {len(schemas)} schemas.')
print('Not full OpenAPI-aware validation; Prisma/SQL/HTTP/browser/deployment remain unverified.')
