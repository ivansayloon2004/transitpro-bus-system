# TransitPro Bus Ticketing and Scheduling System

TransitPro is a bus ticketing and scheduling system with a browser UI plus a shared Node.js server. Passenger accounts, admin accounts, routes, buses, schedules, bookings, tickets, seat states, manifests, and reports can now be shared across devices through the server snapshot database.

The app starts with empty data so you can create your own admin account, routes, buses, schedules, and passengers from scratch.

## Features

- Online ticket booking with passenger details, route selection, and fare calculation
- Schedule lookup based on origin, destination, and date of travel
- Visual bus seat layout with available, reserved, occupied, and selected seat states
- Shared multi-device data sync through the server
- Booking confirmation and printable e-ticket flow
- Booking history for passengers
- Route search and filtering
- Admin login and dashboard
- Schedule creation, editing, and deletion
- Bus and route management with edit and delete actions
- Admin seat availability controls for reserving or releasing seats per schedule
- Booking and revenue reporting
- JSON backup and restore
- Ticket verification page
- Boarding manifest and audit log

## Tech Stack

- `HTML`
- `CSS`
- `JavaScript`
- `IndexedDB` for local browser caching
- `Express`
- `SQLite` via `node:sqlite` for the shared server snapshot
- `localStorage` for browser session state

## Project Structure

- `index.html` - passenger application
- `admin.html` - admin dashboard
- `login.html` - passenger login
- `register.html` - passenger registration
- `admin-login.html` - admin login
- `verify.html` - ticket verification page
- `styles.css` - UI styling and responsive design
- `app.js` - frontend logic, IndexedDB cache, sync, reporting, and admin flows
- `server.js` - Express server and shared snapshot API
- `transitpro-shared.db` - shared SQLite snapshot database
- `render.yaml` - Render deployment config
- `database-schema.sql` - older SQL reference kept for comparison

## How to Run

### Local Run

Run:

```powershell
cd C:\Users\ryzen\Documents\bus
& '.\.tools\node-v22.14.0-win-x64\node.exe' server.js
```

Then open one of these:

```text
http://localhost:3000/login
http://localhost:3000/register
http://localhost:3000/admin-login
http://localhost:3000/app
http://localhost:3000/admin
http://localhost:3000/verify
```

## Public Deployment

This project is prepared for deployment on Render.

### Deploy on Render

1. Push this project to GitHub.
2. Create a new Render Web Service from that repo.
3. Use Node `22` or newer.
4. Render can detect [render.yaml](C:\Users\ryzen\Documents\bus\render.yaml) automatically.
5. Set an environment variable:
   - `PUBLIC_BASE_URL=https://your-app-name.onrender.com`
6. Deploy.

After deployment, everyone can open the public URL, for example:

```text
https://your-app-name.onrender.com/login
https://your-app-name.onrender.com/admin-login
https://your-app-name.onrender.com/app
https://your-app-name.onrender.com/admin
```

## Data Storage

- Local browser cache: `IndexedDB` database `transitpro-browser-db-clean`
- Shared server database: [transitpro-shared.db](C:\Users\ryzen\Documents\bus\transitpro-shared.db)

Browser-side stores include:

- `passengers`
- `admins`
- `buses`
- `routes`
- `schedules`
- `seats`
- `seatStates`
- `bookings`
- `tickets`
- `auditLogs`
- `meta`

`localStorage` is only used for the current login session.

## Notes

- Clearing site data in the browser will remove the saved IndexedDB records for that browser profile.
- Use the admin dashboard backup tools to export and restore JSON backups.
- Use `Sync Local To Server` when you want to push the current browser copy to the shared server.
- Public internet access requires deployment to a hosting provider such as Render, Railway, or another Node host.
