-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('AGENT', 'LEAD', 'CUSTOMER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('URGENT', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('AGENT', 'LEAD', 'ADMIN', 'CUSTOMER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditTarget" AS ENUM ('TICKET', 'SWEEP');

-- CreateEnum
CREATE TYPE "ClockKind" AS ENUM ('RESPONSE', 'RESOLUTION');

-- CreateEnum
CREATE TYPE "ClockState" AS ENUM ('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('INTAKE', 'REPLY', 'REQUEST', 'NOTE');

-- CreateEnum
CREATE TYPE "SweepState" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('AUTO_CLOSED_NO_REPLY', 'RESOLUTION_WINDOW_EXPIRED');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "status" "Status" NOT NULL DEFAULT 'OPEN',
    "priority" "Priority" NOT NULL,
    "requestedPriority" "Priority",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parentTicketId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "resolutionCycle" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMPTZ(3),
    "closeReason" "CloseReason",
    "reopenUntil" TIMESTAMPTZ(3),
    "waitingCloseDueAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "waitingSince" TIMESTAMPTZ(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaClock" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "kind" "ClockKind" NOT NULL,
    "state" "ClockState" NOT NULL,
    "cycleStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "budgetMs" BIGINT NOT NULL,
    "consumedMs" BIGINT NOT NULL DEFAULT 0,
    "currentLate" BOOLEAN NOT NULL DEFAULT false,
    "breachSequence" INTEGER NOT NULL DEFAULT 0,
    "policyRevision" INTEGER NOT NULL DEFAULT 0,
    "runningSince" TIMESTAMPTZ(3),
    "deadlineAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "firstBreachedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SlaClock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "target" "AuditTarget" NOT NULL,
    "ticketId" TEXT,
    "sweepId" TEXT,
    "correlationId" TEXT NOT NULL,
    "reasonCode" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "eventKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "day" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SweepInvocation" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "state" "SweepState" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "leaseUntil" TIMESTAMPTZ(3) NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "autoClosed" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "breachesRecorded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "finishedAt" TIMESTAMPTZ(3),
    "result" JSONB,

    CONSTRAINT "SweepInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB,
    "responseStatus" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Ticket_assigneeId_status_idx" ON "Ticket"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "Ticket_status_waitingSince_idx" ON "Ticket"("status", "waitingSince");

-- CreateIndex
CREATE INDEX "Ticket_status_waitingCloseDueAt_idx" ON "Ticket"("status", "waitingCloseDueAt");

-- CreateIndex
CREATE INDEX "Ticket_status_reopenUntil_idx" ON "Ticket"("status", "reopenUntil");

-- CreateIndex
CREATE INDEX "Ticket_customerId_createdAt_id_idx" ON "Ticket"("customerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SlaClock_state_deadlineAt_idx" ON "SlaClock"("state", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlaClock_ticketId_cycle_kind_key" ON "SlaClock"("ticketId", "cycle", "kind");

-- CreateIndex
CREATE INDEX "Message_ticketId_visibility_createdAt_id_idx" ON "Message"("ticketId", "visibility", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Message_ticketId_createdAt_id_idx" ON "Message"("ticketId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_eventKey_key" ON "audit_logs"("eventKey");

-- CreateIndex
CREATE INDEX "audit_logs_ticketId_createdAt_id_idx" ON "audit_logs"("ticketId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "audit_logs_sweepId_createdAt_id_idx" ON "audit_logs"("sweepId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "audit_logs_correlationId_idx" ON "audit_logs"("correlationId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SweepInvocation_key_key" ON "SweepInvocation"("key");

-- CreateIndex
CREATE INDEX "SweepInvocation_state_leaseUntil_id_idx" ON "SweepInvocation"("state", "leaseUntil", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_actorId_operation_key_key" ON "IdempotencyRecord"("actorId", "operation", "key");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_parentTicketId_fkey" FOREIGN KEY ("parentTicketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlaClock" ADD CONSTRAINT "SlaClock_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_sweepId_fkey" FOREIGN KEY ("sweepId") REFERENCES "SweepInvocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepInvocation" ADD CONSTRAINT "SweepInvocation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

