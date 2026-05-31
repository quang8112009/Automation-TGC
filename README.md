# AutoTGC - Automation Platform

AutoTGC is an AI-powered content-marketing automation platform.

## 🚀 Technologies Used

### Backend (`autotgc-backend`)
- **Framework**: Fastify (Node.js)
- **Language**: TypeScript
- **Database ORM**: Prisma
- **Queue/Jobs**: BullMQ, Redis
- **Security & Utilities**: JWT (jose), Helmet, Rate Limit
- **Testing**: Vitest

### Frontend (`autotgc-frontend`)
- **Framework**: React.js with Vite
- **Language**: TypeScript
- **State/Data Fetching**: React Query
- **Routing**: React Router DOM

## 📁 Project Structure

```text
├── autotgc-backend/       # Fastify backend service (API, WebSockets, Background Jobs)
├── autotgc-frontend/      # React frontend application (UI/UX)
└── README.md
```

## 🛠️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (>= 20.x)
- [Redis](https://redis.io/) (for BullMQ queues)
- Database (PostgreSQL/MySQL - depending on your Prisma config)

### 1. Backend Setup
Navigate to the backend directory:
```bash
cd autotgc-backend
```

Install dependencies:
```bash
npm install
```

Set up environment variables:
```bash
cp .env.example .env
```
*(Make sure to update `.env` with your actual Database URL and Redis connection string)*

Run database migrations and generate Prisma client:
```bash
npm run prisma:generate
npm run prisma:migrate
```

Start the development server:
```bash
npm run dev
```

### 2. Frontend Setup
Navigate to the frontend directory:
```bash
cd autotgc-frontend
```

Install dependencies:
```bash
npm install
```

Start the development server:
```bash
npm run dev
```

## 🧪 Testing

To run backend tests using Vitest:
```bash
cd autotgc-backend
npm run test
```

## 📜 License
This project is UNLICENSED (Proprietary).
