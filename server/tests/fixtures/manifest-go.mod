module github.com/acme/ledger-feed

go 1.22

toolchain go1.22.3

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/jackc/pgx/v5 v5.5.0
	github.com/stretchr/testify v1.9.0 // indirect
	golang.org/x/sync v0.6.0 // indirect; pulled in by pgx
)

require github.com/redis/go-redis/v9 v9.3.0

replace github.com/acme/shared => ../shared

exclude github.com/old/thing v1.0.0
