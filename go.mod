// Sshwifty - A Web SSH client
//
// Copyright (C) 2019-2025 Ni Rui <ranqus@gmail.com>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

module github.com/nirui/sshwifty

go 1.24.0

toolchain go1.24.3

require (
	github.com/gorilla/websocket v1.5.3
	github.com/pkg/sftp v1.13.10
	golang.org/x/crypto v0.47.0
	golang.org/x/net v0.49.0
)

require (
	github.com/kr/fs v0.1.0 // indirect
	golang.org/x/sys v0.40.0 // indirect
)
