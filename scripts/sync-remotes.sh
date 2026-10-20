#!/bin/sh
# Полная сверка трёх копий репозитория: локально, Gitea, GitHub.
#
# Что делает:
#   1. fetch с обоих серверов + prune (узнаём, что кто-то запушил мимо нас);
#   2. удаляет на серверах ветки, которых больше нет локально;
#   3. заливает на серверы все локальные ветки проекта.
#
# Обычный `git push` уже уезжает на оба сервера сам (у remote два push-url),
# поэтому скрипт нужен только когда надо привести всё к одному состоянию —
# например, после правки в веб-интерфейсе GitHub.
#
#   sh scripts/sync-remotes.sh
set -e
cd "$(git rev-parse --show-toplevel)"

GITEA_URL=https://git.mizernyukmy.netcraze.pro/maksim/Notebook-LM-clon.git
GITHUB_URL=https://github.com/papirosa3214/notebook-lm-clone.git

git fetch --all --prune

# Ветки проекта: все локальные, кроме служебных веток воркспейсов агентов.
branches=$(git for-each-ref --format='%(refname:strip=2)' refs/heads/ \
  | grep -v '^traycer/' || true)

sync_to() {
  name=$1
  url=$2

  echo "== $name =="

  # Убрать на сервере ветки, которых нет локально.
  for b in $(git for-each-ref --format='%(refname:strip=3)' "refs/remotes/$name/" \
    | grep -v '^HEAD$'); do
    echo "$branches" | grep -Fqx "$b" || git push "$url" ":refs/heads/$b"
  done

  # Залить локальные ветки.
  if [ -n "$branches" ]; then
    # shellcheck disable=SC2086
    git push "$url" $branches
  fi
}

sync_to gitea "$GITEA_URL"
sync_to github "$GITHUB_URL"

echo "готово: локально, Gitea и GitHub синхронизированы"
