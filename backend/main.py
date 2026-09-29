from datetime import datetime, timedelta, timezone
import asyncio
from threading import Lock
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from .core import CaseStatus, RequestStatus
from .services.allocation_engine import DEFAULT_WEIGHTS, rank_hospitals as calculate_rankings
from .services.websocket_manager import manager
from .services.reservation_service import reserve_resources

BASE_DIR = Path(__file__).resolve().parent
engine = create_engine(f"sqlite:///{BASE_DIR / 'era.db'}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

class Base(DeclarativeBase): pass

class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)
    username: Mapped[str] = mapped_column(String, unique=True)
    password: Mapped[str] = mapped_column(String)
    ambulance_id: Mapped[str | None] = mapped_column(String, nullable=True)
    hospital_id: Mapped[str | None] = mapped_column(String, nullable=True)

class Hospital(Base):
    __tablename__ = "hospitals"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    address: Mapped[str] = mapped_column(String)
    lat: Mapped[float] = mapped_column()
    lng: Mapped[float] = mapped_column()
    resources: Mapped[dict[str, int]] = mapped_column(JSON)
    total_resources: Mapped[dict[str, int] | None] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

class Ambulance(Base):
    __tablename__ = "ambulances"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    operator_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String, default="AVAILABLE")
    lat: Mapped[float] = mapped_column()
    lng: Mapped[float] = mapped_column()
    current_case_id: Mapped[str | None] = mapped_column(String, nullable=True)
    target_lat: Mapped[float | None] = mapped_column(nullable=True)
    target_lng: Mapped[float | None] = mapped_column(nullable=True)

class Case(Base):
    __tablename__ = "cases"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    patient_name: Mapped[str] = mapped_column(String)
    age: Mapped[int] = mapped_column(Integer)
    sex: Mapped[str] = mapped_column(String)
    severity: Mapped[str] = mapped_column(String)
    condition: Mapped[str] = mapped_column(String)
    location_label: Mapped[str] = mapped_column(String)
    notes: Mapped[str] = mapped_column(String, default="")
    requirements: Mapped[dict[str, int]] = mapped_column(JSON)
    ambulance_id: Mapped[str] = mapped_column(ForeignKey("ambulances.id"))
    status: Mapped[str] = mapped_column(String, default="AWAITING_CONFIRMATION")
    pending_hospital_id: Mapped[str | None] = mapped_column(String, nullable=True)
    assigned_hospital_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reallocation_count: Mapped[int] = mapped_column(Integer, default=0)

class Request(Base):
    __tablename__ = "requests"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id"))
    hospital_id: Mapped[str] = mapped_column(ForeignKey("hospitals.id"))
    status: Mapped[str] = mapped_column(String, default="PENDING")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str] = mapped_column(String, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt_number: Mapped[int] = mapped_column(Integer, default=1)
    is_override: Mapped[bool] = mapped_column(default=False)

class Reservation(Base):
    __tablename__ = "reservations"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id"))
    hospital_id: Mapped[str] = mapped_column(ForeignKey("hospitals.id"))
    resources: Mapped[dict[str, int]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String, default="ACTIVE")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    event_type: Mapped[str] = mapped_column(String)
    actor: Mapped[str] = mapped_column(String, default="system")
    case_id: Mapped[str | None] = mapped_column(String, nullable=True)
    hospital_id: Mapped[str | None] = mapped_column(String, nullable=True)
    ambulance_id: Mapped[str | None] = mapped_column(String, nullable=True)
    message: Mapped[str] = mapped_column(String)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)

Base.metadata.create_all(engine)
def migrate_schema():
    with engine.begin() as connection:
        columns = connection.execute(text("PRAGMA table_info(requests)")).fetchall()
        names = {row[1] for row in columns}
        for name, definition in [("responded_at", "DATETIME"), ("attempt_number", "INTEGER DEFAULT 1"), ("is_override", "BOOLEAN DEFAULT 0")]:
            if name not in names: connection.execute(text(f"ALTER TABLE requests ADD COLUMN {name} {definition}"))
        columns = connection.execute(text("PRAGMA table_info(reservations)")).fetchall()
        if "released_at" not in {row[1] for row in columns}: connection.execute(text("ALTER TABLE reservations ADD COLUMN released_at DATETIME"))
        columns = connection.execute(text("PRAGMA table_info(cases)")).fetchall()
        if "reallocation_count" not in {row[1] for row in columns}: connection.execute(text("ALTER TABLE cases ADD COLUMN reallocation_count INTEGER DEFAULT 0"))
        columns = connection.execute(text("PRAGMA table_info(hospitals)")).fetchall()
        if "total_resources" not in {row[1] for row in columns}: connection.execute(text("ALTER TABLE hospitals ADD COLUMN total_resources JSON"))
        columns = connection.execute(text("PRAGMA table_info(ambulances)")).fetchall()
        names = {row[1] for row in columns}
        if "target_lat" not in names: connection.execute(text("ALTER TABLE ambulances ADD COLUMN target_lat FLOAT"))
        if "target_lng" not in names: connection.execute(text("ALTER TABLE ambulances ADD COLUMN target_lng FLOAT"))
migrate_schema()
TOKENS: dict[str, str] = {}
reservation_transaction_lock = Lock()

class LoginPayload(BaseModel): username: str; password: str
class CasePayload(BaseModel):
    patient_name: str = Field(min_length=1)
    age: int = Field(ge=0, le=120)
    sex: str
    severity: str
    condition: str = Field(min_length=1)
    location_label: str = "Current ambulance location"
    notes: str = ""
    requirements: dict[str, int] = {}
class ResourcePayload(BaseModel): resources: dict[str, int]
class ResponsePayload(BaseModel): decision: str; reason: str = ""
class OverridePayload(BaseModel): hospital_id: str; reason: str = "Dispatcher override"
class HospitalSelectionPayload(BaseModel): hospital_id: str
class SimulationScenarioPayload(BaseModel): hospital_id: str = "H-01"

app = FastAPI(title="ERA Emergency Resource Allocator API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_origin_regex=r"https?://(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str | None = None):
    channel = "dispatcher"
    with SessionLocal() as session:
        try:
            user = user_from_token(token, session)
            channel = "dispatcher" if user.role == "dispatcher" else f"{user.role}:{user.ambulance_id or user.hospital_id}"
            await manager.connect(websocket, channel)
            while True: await websocket.receive_text()
        except WebSocketDisconnect: manager.disconnect(websocket, channel)
        except HTTPException: await websocket.close(code=4401)

async def timeout_worker():
    while True:
        await asyncio.sleep(5)
        with SessionLocal() as session:
            process_expired_requests(session)
            advance_simulated_ambulances(session)

@app.on_event("startup")
async def startup_worker():
    asyncio.create_task(timeout_worker())

def utcnow(): return datetime.now(timezone.utc)
def utc_value(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
def timestamp(value: datetime) -> float: return utc_value(value).timestamp()
def db():
    with SessionLocal() as session: yield session

def seed():
    with SessionLocal() as session:
        if session.scalar(select(User).limit(1)):
            for index, hospital_id in enumerate(["H-01", "H-02", "H-03", "H-04"], start=1):
                if not session.scalar(select(User).where(User.username == f"hospital{index}")):
                    hospital = session.get(Hospital, hospital_id)
                    session.add(User(id=f"{hospital_id.lower()}-canonical-user", name=hospital.name, role="hospital", username=f"hospital{index}", password="hosp123", hospital_id=hospital_id))
            session.commit()
            return
        users = [User(id="disp-1", name="Central Dispatcher", role="dispatcher", username="dispatcher", password="dispatch123")]
        for i in range(1, 5): users.append(User(id=f"amb-{i}", name=f"Ambulance Operator A{i}", role="ambulance", username=f"ambulance{i}", password="amb123", ambulance_id=f"AMB-{i:02d}"))
        hospitals = [
            ("H-01", "CityCare General Hospital", "Central Pune", 18.5204, 73.8567, {"icu":4,"ventilator":3,"ot":2,"trauma":3,"bloodOneg":6,"cardiology":2,"neuro":2,"pediatric":3}),
            ("H-02", "Metro Trauma & Critical Care", "Shivajinagar", 18.5314, 73.8446, {"icu":2,"ventilator":2,"ot":3,"trauma":5,"bloodOneg":2,"cardiology":1,"neuro":1,"pediatric":1}),
            ("H-03", "Riverside Medical Center", "Aundh", 18.5074, 73.8077, {"icu":5,"ventilator":1,"ot":1,"trauma":2,"bloodOneg":8,"cardiology":3,"neuro":3,"pediatric":4}),
            ("H-04", "Sunrise Multispeciality Hospital", "Baner", 18.5590, 73.7868, {"icu":3,"ventilator":3,"ot":2,"trauma":1,"bloodOneg":4,"cardiology":2,"neuro":2,"pediatric":2}),
        ]
        for hid, name, address, lat, lng, resources in hospitals:
            users.append(User(id=f"{hid.lower()}-user", name=name, role="hospital", username=f"hospital{hid[-1]}", password="hosp123", hospital_id=hid))
            session.add(Hospital(id=hid, name=name, address=address, lat=lat, lng=lng, resources=resources, total_resources=dict(resources), updated_at=utcnow()))
        session.add_all(users)
        for i in range(1, 5):
            session.add(Ambulance(id=f"AMB-{i:02d}", operator_id=f"amb-{i}", lat=hospitals[i-1][3], lng=hospitals[i-1][4]))
        session.commit()
seed()

def user_from_token(token: str | None, session: Session) -> User:
    if not token or token not in TOKENS: raise HTTPException(status_code=401, detail="Sign in required")
    user = session.get(User, TOKENS[token])
    if not user: raise HTTPException(status_code=401, detail="Invalid session")
    return user

def audit(session: Session, event_type: str, message: str, *, actor="system", case_id=None, hospital_id=None, ambulance_id=None, metadata=None):
    session.add(AuditEvent(id=f"EVT-{uuid4().hex[:10].upper()}", timestamp=utcnow(), event_type=event_type, actor=actor, case_id=case_id, hospital_id=hospital_id, ambulance_id=ambulance_id, message=message, metadata_json=metadata or {}))

def publish(event_type: str, payload: dict, channels: set[str]):
    try: asyncio.get_running_loop().create_task(manager.publish({"type": event_type, "payload": payload}, channels))
    except RuntimeError: pass

def create_requests_for_case(session: Session, case: Case, rankings: list[dict], *, excluded: set[str] | None = None, is_override=False):
    excluded = excluded or set()
    eligible = [item for item in rankings if item["eligible"] and item["hospital_id"] not in excluded]
    if not eligible:
        case.status = CaseStatus.NO_HOSPITAL.value
        case.pending_hospital_id = None
        return []
    requests = []
    for index, item in enumerate(eligible[:3]):
        request = Request(id=f"REQ-{uuid4().hex[:8].upper()}", case_id=case.id, hospital_id=item["hospital_id"], status=RequestStatus.PENDING.value if index == 0 else RequestStatus.STANDBY.value, expires_at=utcnow() + timedelta(seconds=60) if index == 0 else utcnow() + timedelta(seconds=3600), created_at=utcnow(), attempt_number=(case.reallocation_count or 0) + 1, is_override=is_override)
        session.add(request); requests.append(request)
    case.pending_hospital_id = eligible[0]["hospital_id"]; case.status = CaseStatus.AWAITING_CONFIRMATION.value
    return requests

def reallocate_case(session: Session, case: Case, *, reason: str, actor="system", excluded: set[str] | None = None):
    case.reallocation_count = (case.reallocation_count or 0) + 1
    case.status = CaseStatus.REALLOCATING.value
    excluded = excluded or set()
    rankings = rank_hospitals(session, session.get(Ambulance, case.ambulance_id), case)
    request_rows = session.scalars(select(Request).where(Request.case_id == case.id, Request.status.in_([RequestStatus.PENDING.value, RequestStatus.STANDBY.value]))).all()
    excluded.update(request.hospital_id for request in request_rows if request.status == RequestStatus.PENDING.value)
    for request in request_rows:
        request.status = RequestStatus.CANCELLED.value; request.responded_at = utcnow(); request.reason = reason
    requests = create_requests_for_case(session, case, rankings, excluded=excluded)
    audit(session, "REALLOCATION_STARTED", f"{case.id}: {reason}.", actor=actor, case_id=case.id, metadata={"attempt": case.reallocation_count})
    if requests: audit(session, "REQUEST_CREATED", f"Reallocation request sent to {requests[0].hospital_id}.", actor="allocation-engine", case_id=case.id, hospital_id=requests[0].hospital_id)
    session.commit()
    publish("case.updated", as_dict(case), {"dispatcher", f"ambulance:{case.ambulance_id}", *(f"hospital:{request.hospital_id}" for request in requests)})
    return requests

def process_expired_requests(session: Session):
    expired = session.scalars(select(Request).where(Request.status == RequestStatus.PENDING.value, Request.expires_at <= utcnow())).all()
    for request in expired:
        request.status = RequestStatus.EXPIRED.value; request.responded_at = utcnow(); request.reason = "Response timeout"
        case = session.get(Case, request.case_id)
        if case and case.status != CaseStatus.ASSIGNED.value: reallocate_case(session, case, reason="Hospital response timeout", excluded={request.hospital_id})
    if expired: session.commit()
    return len(expired)

def create_case_record(session: Session, ambulance: Ambulance, payload: CasePayload, actor: str):
    case = Case(id=f"CASE-{uuid4().hex[:8].upper()}", ambulance_id=ambulance.id, patient_name=payload.patient_name, age=payload.age, sex=payload.sex, severity=payload.severity, condition=payload.condition, location_label=payload.location_label, notes=payload.notes, requirements={k: v for k, v in payload.requirements.items() if v > 0}, created_at=utcnow())
    ranked = rank_hospitals(session, ambulance, case)
    requests = create_requests_for_case(session, case, ranked)
    audit(session, "CASE_CREATED", f"Emergency {case.id} created.", actor=actor, case_id=case.id, ambulance_id=ambulance.id)
    if requests:
        audit(session, "RANKING_COMPLETED", f"Ranked {len(ranked)} hospitals for {case.id}.", actor="allocation-engine", case_id=case.id)
        audit(session, "REQUEST_CREATED", f"Primary request sent to {requests[0].hospital_id}.", actor="allocation-engine", case_id=case.id, hospital_id=requests[0].hospital_id)
    ambulance.status = "AWAITING_CONFIRMATION"; ambulance.current_case_id = case.id
    session.add(case); session.commit()
    publish("case.created", as_dict(case), {"dispatcher", f"ambulance:{ambulance.id}", *(f"hospital:{request.hospital_id}" for request in requests)})
    return case, ranked, requests

def advance_simulated_ambulances(session: Session):
    moved = []
    for ambulance in session.scalars(select(Ambulance).where(Ambulance.status == "EN_ROUTE")).all():
        if ambulance.target_lat is None or ambulance.target_lng is None: continue
        lat_delta, lng_delta = ambulance.target_lat - ambulance.lat, ambulance.target_lng - ambulance.lng
        distance = (lat_delta ** 2 + lng_delta ** 2) ** 0.5
        if distance <= 0.001:
            ambulance.lat, ambulance.lng = ambulance.target_lat, ambulance.target_lng; ambulance.status = "AT_HOSPITAL"
            case = session.get(Case, ambulance.current_case_id) if ambulance.current_case_id else None
            if case and case.status == CaseStatus.ASSIGNED.value:
                case.status = CaseStatus.AT_HOSPITAL.value; audit(session, "AMBULANCE_ARRIVED", f"{ambulance.id} arrived at destination.", actor="simulation", case_id=case.id, hospital_id=case.assigned_hospital_id, ambulance_id=ambulance.id)
            moved.append(ambulance.id)
        else:
            step = min(0.35, 0.006 / distance)
            ambulance.lat += lat_delta * step; ambulance.lng += lng_delta * step; moved.append(ambulance.id)
    if moved: session.commit()
    for ambulance_id in moved: publish("ambulance.updated", as_dict(session.get(Ambulance, ambulance_id)), {"dispatcher", f"ambulance:{ambulance_id}"})
    return len(moved)

async def run_guided_demo(case_id: str):
    """Drive a visible demo through request, reallocation, acceptance and arrival."""
    await asyncio.sleep(3)
    with SessionLocal() as session:
        case = session.get(Case, case_id)
        if not case: return
        primary = session.scalar(select(Request).where(Request.case_id == case_id, Request.status == RequestStatus.PENDING.value).order_by(Request.created_at.asc()))
        if not primary: return
        primary.status = RequestStatus.REJECTED.value; primary.responded_at = utcnow(); primary.reason = "Guided demo: first hospital unavailable"
        requests = reallocate_case(session, case, reason="Guided demo rejection", actor="simulation", excluded={primary.hospital_id})
        publish("simulation.step", {"step": "reallocated", "case_id": case_id}, {"dispatcher", f"ambulance:{case.ambulance_id}"})
    await asyncio.sleep(3)
    with SessionLocal() as session:
        case = session.get(Case, case_id); request = session.scalar(select(Request).where(Request.case_id == case_id, Request.status == RequestStatus.PENDING.value).order_by(Request.created_at.asc()))
        if not case or not request: return
        hospital = session.get(Hospital, request.hospital_id)
        result = reserve_resources(hospital.resources, case.requirements)
        if not result.accepted: return
        hospital.resources = result.resources; hospital.updated_at = utcnow(); request.status = RequestStatus.ACCEPTED.value; request.responded_at = utcnow(); case.status = CaseStatus.ASSIGNED.value; case.assigned_hospital_id = hospital.id; case.pending_hospital_id = None
        for row in session.scalars(select(Request).where(Request.case_id == case_id, Request.status == RequestStatus.STANDBY.value)).all(): row.status = RequestStatus.CANCELLED.value; row.responded_at = utcnow(); row.reason = "Guided demo hospital accepted"
        session.add(Reservation(id=f"RES-{uuid4().hex[:8].upper()}", case_id=case.id, hospital_id=hospital.id, resources=case.requirements, created_at=utcnow()))
        ambulance = session.get(Ambulance, case.ambulance_id); ambulance.status = "EN_ROUTE"; ambulance.target_lat = hospital.lat; ambulance.target_lng = hospital.lng
        audit(session, "REQUEST_ACCEPTED", f"Guided demo: {hospital.name} accepted.", actor="simulation", case_id=case.id, hospital_id=hospital.id); audit(session, "RESERVATION_CREATED", "Guided demo resources reserved.", actor="simulation", case_id=case.id, hospital_id=hospital.id); audit(session, "AMBULANCE_EN_ROUTE", f"{ambulance.id} started toward {hospital.name}.", actor="simulation", case_id=case.id, hospital_id=hospital.id, ambulance_id=ambulance.id); session.commit()
        publish("simulation.step", {"step": "accepted_and_en_route", "case_id": case_id}, {"dispatcher", f"ambulance:{ambulance.id}", f"hospital:{hospital.id}"})

def as_dict(obj: Any):
    if isinstance(obj, datetime): return obj.isoformat()
    if isinstance(obj, list): return [as_dict(x) for x in obj]
    if hasattr(obj, "__table__"):
        return {c.name: as_dict(getattr(obj, c.name)) for c in obj.__table__.columns}
    if isinstance(obj, dict): return {k: as_dict(v) for k, v in obj.items()}
    return obj

def rank_hospitals(session: Session, ambulance: Ambulance, case: Case):
    hospitals = [{**as_dict(hospital), "updated_at": timestamp(hospital.updated_at)} for hospital in session.scalars(select(Hospital)).all()]
    return [result.as_dict() for result in calculate_rankings(hospitals=hospitals, requirements=case.requirements or {}, ambulance_location=(ambulance.lat, ambulance.lng), now_timestamp=utcnow().timestamp(), weights=DEFAULT_WEIGHTS)]

def case_detail(session: Session, case: Case):
    ambulance = session.get(Ambulance, case.ambulance_id)
    operator = session.get(User, ambulance.operator_id) if ambulance else None
    requests = session.scalars(select(Request).where(Request.case_id == case.id).order_by(Request.created_at.asc())).all()
    reservations = session.scalars(select(Reservation).where(Reservation.case_id == case.id).order_by(Reservation.created_at.asc())).all()
    audit_rows = session.scalars(select(AuditEvent).where(AuditEvent.case_id == case.id).order_by(AuditEvent.timestamp.asc())).all()
    return {"case": as_dict(case), "ambulance": as_dict(ambulance), "operator": as_dict(operator), "requests": [as_dict(row) for row in requests], "reservations": [as_dict(row) for row in reservations], "audit": [as_dict(row) for row in audit_rows], "ranking": rank_hospitals(session, ambulance, case) if ambulance else []}

def hospital_detail(session: Session, hospital: Hospital):
    active_reservations = session.scalars(select(Reservation).where(Reservation.hospital_id == hospital.id, Reservation.status == "ACTIVE")).all()
    reserved = {key: 0 for key in (hospital.resources or {})}
    commitments = []
    for reservation in active_reservations:
        for key, amount in (reservation.resources or {}).items(): reserved[key] = reserved.get(key, 0) + amount
        case = session.get(Case, reservation.case_id)
        commitments.append({"reservation": as_dict(reservation), "case": as_dict(case)})
    age = max(0, int(utcnow().timestamp() - timestamp(hospital.updated_at)))
    freshness = "FRESH" if age <= 30 else "RECENT" if age <= 120 else "AGING" if age <= 300 else "STALE"
    requests = session.scalars(select(Request).where(Request.hospital_id == hospital.id, Request.status.in_([RequestStatus.PENDING.value, RequestStatus.STANDBY.value]))).all()
    total = hospital.total_resources or hospital.resources or {}
    return {"hospital": as_dict(hospital), "total_resources": total, "reserved_resources": reserved, "commitments": commitments, "requests": [as_dict(row) for row in requests], "freshness": {"status": freshness, "age_seconds": age}}

def auth_user(session: Session = Depends(db), authorization: str | None = Header(default=None)):
    return user_from_token(authorization.removeprefix("Bearer ") if authorization else None, session)

@app.get("/api/health")
def health(): return {"status": "ok"}

@app.post("/api/auth/login")
def login(payload: LoginPayload, session: Session = Depends(db)):
    user = session.scalar(select(User).where(User.username == payload.username, User.password == payload.password))
    if not user: raise HTTPException(status_code=401, detail="Invalid demo credentials")
    token = uuid4().hex; TOKENS[token] = user.id
    return {"token": token, "user": as_dict(user)}

@app.get("/api/me")
def me(user: User = Depends(auth_user)): return as_dict(user)

@app.get("/api/dashboard")
def dashboard(user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role == "ambulance":
        ambulance = session.scalar(select(Ambulance).where(Ambulance.id == user.ambulance_id)); cases = session.scalars(select(Case).where(Case.ambulance_id == ambulance.id).order_by(Case.created_at.desc())).all(); requests = session.scalars(select(Request).join(Case, Request.case_id == Case.id).where(Case.ambulance_id == ambulance.id).order_by(Request.created_at.desc())).all()
        rankings = {case.id: rank_hospitals(session, ambulance, case) for case in cases}
        return {"ambulance": as_dict(ambulance), "cases": [as_dict(c) for c in cases], "requests": [as_dict(row) for row in requests], "rankings": rankings}
    if user.role == "hospital":
        hospital = session.get(Hospital, user.hospital_id); requests = session.scalars(select(Request).where(Request.hospital_id == user.hospital_id).order_by(Request.created_at.desc())).all()
        return {"hospital": as_dict(hospital), "requests": [as_dict(r) for r in requests], "cases": [as_dict(session.get(Case, r.case_id)) for r in requests]}
    cases = session.scalars(select(Case).order_by(Case.created_at.desc())).all(); return {"cases": [as_dict(c) for c in cases], "hospitals": [as_dict(h) for h in session.scalars(select(Hospital)).all()], "ambulances": [as_dict(a) for a in session.scalars(select(Ambulance)).all()], "audit": [as_dict(item) for item in session.scalars(select(AuditEvent).order_by(AuditEvent.timestamp.desc()).limit(100)).all()]}

@app.post("/api/cases")
def create_case(payload: CasePayload, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "ambulance": raise HTTPException(403, "Only ambulance operators create cases")
    ambulance = session.get(Ambulance, user.ambulance_id)
    if not ambulance or ambulance.current_case_id: raise HTTPException(409, "This ambulance already has an active case")
    case, ranked, requests = create_case_record(session, ambulance, payload, user.id)
    return {"case": as_dict(case), "ranking": ranked, "requests": [as_dict(request) for request in requests]}

@app.get("/api/cases/{case_id}/ranking")
def ranking(case_id: str, user: User = Depends(auth_user), session: Session = Depends(db)):
    case = session.get(Case, case_id); ambulance = session.get(Ambulance, case.ambulance_id) if case else None
    if not case or not ambulance: raise HTTPException(404, "Case not found")
    return rank_hospitals(session, ambulance, case)

@app.get("/api/cases/{case_id}/requests")
def case_requests(case_id: str, user: User = Depends(auth_user), session: Session = Depends(db)):
    case = session.get(Case, case_id)
    if not case: raise HTTPException(404, "Case not found")
    if user.role == "ambulance" and case.ambulance_id != user.ambulance_id: raise HTTPException(403, "Not allowed")
    rows = session.scalars(select(Request).where(Request.case_id == case_id).order_by(Request.created_at.desc())).all()
    return [as_dict(row) for row in rows]

@app.get("/api/cases/{case_id}/detail")
def get_case_detail(case_id: str, user: User = Depends(auth_user), session: Session = Depends(db)):
    case = session.get(Case, case_id)
    if not case: raise HTTPException(404, "Case not found")
    if user.role == "ambulance" and case.ambulance_id != user.ambulance_id: raise HTTPException(403, "Not allowed")
    return case_detail(session, case)

@app.post("/api/cases/{case_id}/hospital-request")
def select_hospital(case_id: str, payload: HospitalSelectionPayload, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "ambulance": raise HTTPException(403, "Only the assigned ambulance may select a hospital")
    case = session.get(Case, case_id); hospital = session.get(Hospital, payload.hospital_id)
    if not case or not hospital: raise HTTPException(404, "Case or hospital not found")
    if case.ambulance_id != user.ambulance_id: raise HTTPException(403, "Not allowed")
    if case.status in [CaseStatus.COMPLETED.value, CaseStatus.CANCELLED.value]: raise HTTPException(400, "Case is no longer active")
    rankings = rank_hospitals(session, session.get(Ambulance, case.ambulance_id), case)
    selected = next((item for item in rankings if item["hospital_id"] == hospital.id), None)
    if not selected or not selected["eligible"]: raise HTTPException(409, "Selected hospital cannot satisfy the current requirements")
    active = session.scalars(select(Request).where(Request.case_id == case.id, Request.status.in_([RequestStatus.PENDING.value, RequestStatus.STANDBY.value]))).all()
    for request in active:
        request.status = RequestStatus.CANCELLED.value; request.responded_at = utcnow(); request.reason = "Ambulance selected a different hospital"
    case.pending_hospital_id = hospital.id; case.assigned_hospital_id = None; case.status = CaseStatus.AWAITING_CONFIRMATION.value
    primary = Request(id=f"REQ-{uuid4().hex[:8].upper()}", case_id=case.id, hospital_id=hospital.id, status=RequestStatus.PENDING.value, expires_at=utcnow() + timedelta(seconds=60), created_at=utcnow(), attempt_number=(case.reallocation_count or 0) + 1)
    session.add(primary); audit(session, "AMBULANCE_HOSPITAL_SELECTION", f"Ambulance selected {hospital.name} for review.", actor=user.id, case_id=case.id, hospital_id=hospital.id, ambulance_id=case.ambulance_id); session.commit()
    publish("request.created", as_dict(primary), {"dispatcher", f"ambulance:{case.ambulance_id}", f"hospital:{hospital.id}"})
    return {"request": as_dict(primary), "ranking": rankings}

@app.post("/api/cases/{case_id}/override")
def override_case(case_id: str, payload: OverridePayload, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "dispatcher": raise HTTPException(403, "Dispatcher access required")
    case = session.get(Case, case_id); hospital = session.get(Hospital, payload.hospital_id)
    if not case or not hospital: raise HTTPException(404, "Case or hospital not found")
    ranking = next((item for item in rank_hospitals(session, session.get(Ambulance, case.ambulance_id), case) if item["hospital_id"] == hospital.id), None)
    if not ranking or not ranking["eligible"]: raise HTTPException(409, "Override hospital is not eligible for the current requirements")
    for request in session.scalars(select(Request).where(Request.case_id == case_id, Request.status.in_([RequestStatus.PENDING.value, RequestStatus.STANDBY.value]))).all(): request.status = RequestStatus.CANCELLED.value; request.responded_at = utcnow(); request.reason = "Dispatcher override"
    case.pending_hospital_id = hospital.id; case.status = CaseStatus.AWAITING_CONFIRMATION.value
    request = Request(id=f"REQ-{uuid4().hex[:8].upper()}", case_id=case.id, hospital_id=hospital.id, status=RequestStatus.PENDING.value, expires_at=utcnow()+timedelta(seconds=60), created_at=utcnow(), attempt_number=(case.reallocation_count or 0)+1, is_override=True)
    session.add(request); audit(session, "HOSPITAL_OVERRIDE", payload.reason, actor=user.id, case_id=case.id, hospital_id=hospital.id); session.commit(); publish("case.updated", as_dict(case), {"dispatcher", f"ambulance:{case.ambulance_id}", f"hospital:{hospital.id}"}); return as_dict(request)

@app.post("/api/cases/{case_id}/handoff")
def complete_handoff(case_id: str, user: User = Depends(auth_user), session: Session = Depends(db)):
    case = session.get(Case, case_id)
    if user.role == "dispatcher":
        pass
    elif user.role != "ambulance" or not case or case.ambulance_id != user.ambulance_id:
        raise HTTPException(403, "Only the assigned ambulance operator or dispatcher may complete handoff")
    if not case or case.status != CaseStatus.AT_HOSPITAL.value: raise HTTPException(400, "Mark the ambulance arrived before completing handoff")
    reservation = session.scalar(select(Reservation).where(Reservation.case_id == case_id, Reservation.status == "ACTIVE"))
    if reservation:
        hospital = session.get(Hospital, reservation.hospital_id); resources = dict(hospital.resources)
        for key, value in reservation.resources.items(): resources[key] = resources.get(key, 0) + value
        hospital.resources = resources; reservation.status = "RELEASED"; reservation.released_at = utcnow()
    ambulance = session.get(Ambulance, case.ambulance_id); ambulance.current_case_id = None; ambulance.status = "AVAILABLE"; case.status = CaseStatus.COMPLETED.value; audit(session, "HANDOFF_COMPLETED", f"Handoff completed for {case.patient_name}.", actor=user.id, case_id=case.id, hospital_id=case.assigned_hospital_id, ambulance_id=ambulance.id); audit(session, "RESOURCES_RELEASED", f"Resources released after handoff for {case.patient_name}.", actor="system", case_id=case.id, hospital_id=case.assigned_hospital_id, ambulance_id=ambulance.id); session.commit(); publish("case.updated", as_dict(case), {"dispatcher", f"ambulance:{ambulance.id}", f"hospital:{case.assigned_hospital_id}"}); return as_dict(case)

@app.post("/api/cases/{case_id}/arrived")
def mark_arrived(case_id: str, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "dispatcher": raise HTTPException(403, "Dispatcher access required")
    case = session.get(Case, case_id)
    if not case or case.status != CaseStatus.ASSIGNED.value: raise HTTPException(400, "Only assigned cases can arrive")
    case.status = CaseStatus.AT_HOSPITAL.value; ambulance = session.get(Ambulance, case.ambulance_id); ambulance.status = "AT_HOSPITAL"; audit(session, "AMBULANCE_ARRIVED", f"{case.patient_name} arrived at the assigned hospital.", actor=user.id, case_id=case.id, hospital_id=case.assigned_hospital_id, ambulance_id=ambulance.id); session.commit(); publish("case.updated", as_dict(case), {"dispatcher", f"ambulance:{ambulance.id}", f"hospital:{case.assigned_hospital_id}"}); return as_dict(case)

@app.post("/api/cases/{case_id}/cancel")
def cancel_case(case_id: str, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "dispatcher": raise HTTPException(403, "Dispatcher access required")
    case = session.get(Case, case_id)
    if not case: raise HTTPException(404, "Case not found")
    case.status = CaseStatus.CANCELLED.value
    for request in session.scalars(select(Request).where(Request.case_id == case_id, Request.status.in_([RequestStatus.PENDING.value, RequestStatus.STANDBY.value]))).all(): request.status = RequestStatus.CANCELLED.value; request.responded_at = utcnow(); request.reason = "Case cancelled"
    ambulance = session.get(Ambulance, case.ambulance_id); ambulance.current_case_id = None; ambulance.status = "AVAILABLE"; audit(session, "CASE_CANCELLED", f"Case {case.id} cancelled.", actor=user.id, case_id=case.id); session.commit(); publish("case.updated", as_dict(case), {"dispatcher", f"ambulance:{ambulance.id}"}); return as_dict(case)

@app.get("/api/simulation/state")
def simulation_state(user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "dispatcher": raise HTTPException(403, "Dispatcher access required")
    active_cases = len(session.scalars(select(Case).where(Case.status.not_in([CaseStatus.COMPLETED.value, CaseStatus.CANCELLED.value])).all()))
    return {"active_cases": active_cases, "scenarios": ["guided_demo", "demo_case", "stale_data", "timeout", "rejection", "double_booking", "reset"]}

@app.post("/api/simulation/{scenario}")
def run_simulation(scenario: str, background_tasks: BackgroundTasks, payload: SimulationScenarioPayload | None = None, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "dispatcher": raise HTTPException(403, "Dispatcher access required")
    if scenario == "guided_demo":
        ambulance = session.scalar(select(Ambulance).where(Ambulance.status == "AVAILABLE"))
        if not ambulance: raise HTTPException(409, "No available ambulance for guided demo")
        case, ranking, requests = create_case_record(session, ambulance, CasePayload(patient_name="Guided Demo Patient", age=47, sex="M", severity="CRITICAL", condition="Road traffic trauma", location_label="Demo incident zone", notes="End-to-end guided simulation", requirements={"icu": 1, "ventilator": 1, "trauma": 1}), "simulation")
        background_tasks.add_task(run_guided_demo, case.id)
        return {"message": "Guided demo started", "case": as_dict(case), "ranking": ranking, "requests": [as_dict(row) for row in requests]}
    if scenario == "demo_case":
        ambulance = session.scalar(select(Ambulance).where(Ambulance.status == "AVAILABLE"))
        if not ambulance: raise HTTPException(409, "No available ambulance for demo case")
        case, ranking, requests = create_case_record(session, ambulance, CasePayload(patient_name="Demo Critical Patient", age=47, sex="M", severity="CRITICAL", condition="Road traffic trauma", location_label="Demo incident zone", notes="Dispatcher simulation case", requirements={"icu": 1, "ventilator": 1, "trauma": 1, "bloodOneg": 2}), "simulation")
        return {"message": "Demo emergency created", "case": as_dict(case), "ranking": ranking, "requests": [as_dict(row) for row in requests]}
    if scenario == "stale_data":
        hospital = session.get(Hospital, (payload or SimulationScenarioPayload()).hospital_id); hospital.updated_at = utcnow() - timedelta(minutes=10); audit(session, "SIMULATION_STALE_DATA", f"{hospital.name} marked stale.", actor=user.id, hospital_id=hospital.id); session.commit(); publish("hospital.resources.updated", as_dict(hospital), {"dispatcher"}); return {"message": f"{hospital.name} is now stale", "hospital": as_dict(hospital)}
    pending = session.scalar(select(Request).where(Request.status == RequestStatus.PENDING.value).order_by(Request.created_at.asc()))
    if scenario == "timeout":
        if not pending: raise HTTPException(409, "No pending request to expire")
        pending.expires_at = utcnow() - timedelta(seconds=1); session.commit(); process_expired_requests(session); return {"message": "Pending request expired and reallocation processed"}
    if scenario == "rejection":
        if not pending: raise HTTPException(409, "No pending request to reject")
        pending.status = RequestStatus.REJECTED.value; pending.responded_at = utcnow(); pending.reason = "Simulation rejection"; case = session.get(Case, pending.case_id); requests = reallocate_case(session, case, reason="Simulation rejection", actor=user.id, excluded={pending.hospital_id}); return {"message": "Request rejected and reallocation processed", "requests": [as_dict(row) for row in requests]}
    if scenario == "double_booking":
        hospital = session.get(Hospital, (payload or SimulationScenarioPayload()).hospital_id); resources = dict(hospital.resources); resources["icu"] = 1; hospital.resources = resources; hospital.updated_at = utcnow(); audit(session, "SIMULATION_DOUBLE_BOOKING", f"{hospital.name} reduced to one ICU bed.", actor=user.id, hospital_id=hospital.id); session.commit(); return {"message": f"Double-booking setup ready at {hospital.name}: ICU capacity set to 1"}
    if scenario == "reset":
        for case in session.scalars(select(Case)).all():
            ambulance = session.get(Ambulance, case.ambulance_id); ambulance.status = "AVAILABLE"; ambulance.current_case_id = None; ambulance.target_lat = None; ambulance.target_lng = None
        for hospital in session.scalars(select(Hospital)).all(): hospital.resources = hospital.total_resources or hospital.resources; hospital.updated_at = utcnow()
        session.query(Request).delete(); session.query(Reservation).delete(); session.query(AuditEvent).delete(); session.query(Case).delete(); session.commit(); publish("simulation.reset", {"message": "Simulation reset"}, {"dispatcher"}); return {"message": "Simulation reset"}
    raise HTTPException(404, "Unknown simulation scenario")

@app.post("/api/requests/{request_id}/respond")
def respond(request_id: str, payload: ResponsePayload, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "hospital": raise HTTPException(403, "Only hospitals respond to requests")
    request = session.get(Request, request_id); case = session.get(Case, request.case_id) if request else None; hospital = session.get(Hospital, user.hospital_id) if user.hospital_id else None
    if not request or not case or request.hospital_id != user.hospital_id: raise HTTPException(404, "Request not found")
    if request.status != RequestStatus.PENDING.value: raise HTTPException(409, "Request is no longer pending")
    if utc_value(request.expires_at) <= utcnow():
        request.status = RequestStatus.EXPIRED.value; request.responded_at = utcnow(); request.reason = "Response timeout"; reallocate_case(session, case, reason="Hospital response timeout", excluded={hospital.id}); raise HTTPException(409, "Request has expired")
    if payload.decision == "REJECT":
        request.status = RequestStatus.REJECTED.value; request.responded_at = utcnow(); request.reason = payload.reason or "Hospital unavailable"
        audit(session, "REQUEST_REJECTED", f"{hospital.name} rejected {case.patient_name}.", actor=user.id, case_id=case.id, hospital_id=hospital.id)
        requests = reallocate_case(session, case, reason=f"{hospital.name} rejected request", actor=user.id, excluded={hospital.id})
        publish("request.updated", as_dict(request), {"dispatcher", f"ambulance:{case.ambulance_id}", f"hospital:{hospital.id}", *(f"hospital:{row.hospital_id}" for row in requests)})
        return as_dict(request)
    with reservation_transaction_lock:
        reservation_result = reserve_resources(hospital.resources, case.requirements)
    if not reservation_result.accepted:
        request.status = RequestStatus.CONFLICT.value; request.responded_at = utcnow(); request.reason = reservation_result.reason
        audit(session, "RESERVATION_CONFLICT", request.reason, actor=user.id, case_id=case.id, hospital_id=hospital.id)
        requests = reallocate_case(session, case, reason="Reservation conflict", actor=user.id, excluded={hospital.id})
        publish("reservation.conflict", as_dict(request), {"dispatcher", f"ambulance:{case.ambulance_id}", *(f"hospital:{row.hospital_id}" for row in requests)})
        raise HTTPException(409, request.reason)
    hospital.resources = reservation_result.resources
    hospital.updated_at = utcnow(); request.status = RequestStatus.ACCEPTED.value; request.responded_at = utcnow(); case.status = CaseStatus.ASSIGNED.value; case.assigned_hospital_id = hospital.id; case.pending_hospital_id = None
    standby = session.scalars(select(Request).where(Request.case_id == case.id, Request.status == RequestStatus.STANDBY.value)).all()
    for row in standby: row.status = RequestStatus.CANCELLED.value; row.responded_at = utcnow(); row.reason = "Another hospital accepted the case"
    reservation = Reservation(id=f"RES-{uuid4().hex[:8].upper()}", case_id=case.id, hospital_id=hospital.id, resources=case.requirements, created_at=utcnow())
    session.add(reservation); audit(session, "RESERVATION_CREATED", f"Resources reserved at {hospital.name}.", actor=user.id, case_id=case.id, hospital_id=hospital.id); audit(session, "REQUEST_ACCEPTED", f"{hospital.name} accepted {case.patient_name}.", actor=user.id, case_id=case.id, hospital_id=hospital.id); audit(session, "HOSPITAL_ASSIGNED", f"{hospital.name} assigned to {case.patient_name}.", actor="allocation-engine", case_id=case.id, hospital_id=hospital.id); session.commit()
    ambulance = session.get(Ambulance, case.ambulance_id); ambulance.status = "EN_ROUTE"; ambulance.target_lat = hospital.lat; ambulance.target_lng = hospital.lng; audit(session, "AMBULANCE_EN_ROUTE", f"{ambulance.id} en route to {hospital.name}.", actor="system", case_id=case.id, hospital_id=hospital.id, ambulance_id=ambulance.id); session.commit()
    publish("reservation.created", as_dict(reservation), {"dispatcher", f"ambulance:{case.ambulance_id}", f"hospital:{hospital.id}"})
    return as_dict(request)

@app.put("/api/hospitals/{hospital_id}/resources")
def update_resources(hospital_id: str, payload: ResourcePayload, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role != "hospital" or user.hospital_id != hospital_id: raise HTTPException(403, "Not allowed")
    hospital = session.get(Hospital, hospital_id)
    if not hospital: raise HTTPException(404, "Hospital not found")
    hospital.resources = {k: max(0, int(v)) for k, v in payload.resources.items()}; hospital.total_resources = hospital.total_resources or dict(hospital.resources); hospital.updated_at = utcnow(); audit(session, "RESOURCE_UPDATED", f"{hospital.name} updated availability.", actor=user.id, hospital_id=hospital.id); session.commit(); publish("hospital.resources.updated", as_dict(hospital), {"dispatcher", f"hospital:{hospital.id}"}); return as_dict(hospital)

@app.get("/api/hospitals/{hospital_id}/detail")
def get_hospital_detail(hospital_id: str, user: User = Depends(auth_user), session: Session = Depends(db)):
    if user.role not in ["dispatcher", "hospital"] or (user.role == "hospital" and user.hospital_id != hospital_id): raise HTTPException(403, "Not allowed")
    hospital = session.get(Hospital, hospital_id)
    if not hospital: raise HTTPException(404, "Hospital not found")
    return hospital_detail(session, hospital)
