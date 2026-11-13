# SQLite command-line shell (sqlite3). Sourced by scripts/build-packages.sh.
NAME=sqlite
VERSION=3.47.2
DEPS=-
DESC="SQLite 3 database engine and sqlite3 command-line shell"
URL=https://www.sqlite.org/2024/sqlite-amalgamation-3470200.zip
SHA256=aa73d8748095808471deaa8e6f34aa700e37f2f787f4425744f53fdd15a89c40

build() {
	fetch "$URL" "$SHA256" src.zip
	python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(".")' src.zip
	cd sqlite-amalgamation-*
	# No threads or dlopen in the guest; NOMMU, so no mmap of database files.
	defs=(-DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_DQS=0
		-DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_MATH_FUNCTIONS)
	cc_compile "${defs[@]}" -c sqlite3.c -o sqlite3.o
	cc_compile "${defs[@]}" -c shell.c -o shell.o
	mkdir -p "$DEST/usr/bin"
	cc_link sqlite3.o shell.o -o "$DEST/usr/bin/sqlite3" -lm
}
